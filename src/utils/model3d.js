// 3D vehicle model pipeline — trim-cache-first.
//
// Flow:
//   1. Build a slug from the decoded vehicle's year/make/model/trim + MODEL_VERSION.
//   2. Look up models3d/{slug} in Firestore.
//        - status === 'ready' → use cached glbUrl from R2, done.
//        - status === 'pending' → another client is already generating, poll until ready.
//        - missing or stale → claim it (transactionally), then generate.
//   3. Generate via Tripo3D (image-to-model from user photo, or VinAudit stock photo).
//   4. POST the temporary Tripo URL to /api/models/upload — server fetches it
//      and writes it to R2 at the slug-derived key. Return the permanent R2 URL.
//   5. Update models3d/{slug} → { status: 'ready', glbUrl, generatedAt }.
//
// Two users analyzing different VINs of the same trim share one GLB.
// Bumping MODEL_VERSION (e.g. 'v1' → 'v2') causes new slugs to be generated
// while old ones stay accessible — no eviction, no breakage.

import {
  doc, getDoc, runTransaction, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { fetchVinAuditImages } from './vinAuditImages';

// Dev-only diagnostic logger. Stripped in production builds.
// Filter by typing `[3d]` in the DevTools console filter box.
const dlog = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('%c[3d]', 'color:#2563eb;font-weight:bold', ...args);
  }
};
const dwarn = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('%c[3d]', 'color:#dc2626;font-weight:bold', ...args);
  }
};

// ─── Versioning ───────────────────────────────────────────────────────────────
// Bump this when you change Tripo3D quality settings, post-processing, or
// anything else that should produce a fresh GLB. Old versions remain in R2
// and Firestore — they're never deleted; new traffic just generates new slugs.
export const MODEL_VERSION = 'v1';

// ─── Dev-only CORS bypass for Tripo CDN ───────────────────────────────────────
// Tripo3D's CDN (tripo-data.rg1.data.tripo3d.com) doesn't send
// Access-Control-Allow-Origin, so loading the GLB directly from localhost is
// blocked by the browser. In production we never hit this path because R2
// serves from models.vincritiq.com with CORS configured. In dev we route
// through /dev-glb-proxy (defined in setupProxy.js) which fetches from Tripo
// server-side and re-emits the bytes with permissive CORS.
//
// Important: we DO NOT apply this rewrite before persisting to Firestore —
// the database always stores raw Tripo / R2 URLs. The proxy URL is a
// transient client-side concern.
const TRIPO_CDN_RE = /^https:\/\/[a-z0-9-]+\.(?:rg1\.)?data\.tripo3d\.com\//i;

function maybeProxyForDev(url) {
  if (!url) return url;
  if (typeof window === 'undefined') return url;
  if (process.env.NODE_ENV === 'production') return url;
  if (!TRIPO_CDN_RE.test(url)) return url;
  return `/dev-glb-proxy?url=${encodeURIComponent(url)}`;
}

// Exported alias so callers outside this module (e.g. ChatInterface) can
// route a stored Tripo URL through the dev-only CORS-bypass proxy when
// reading it back from Firestore. Production builds short-circuit and
// return the URL unchanged, so this is safe to call unconditionally.
export const proxyForDevIfNeeded = maybeProxyForDev;
export function isTripoCdnUrl(url) {
  return typeof url === 'string' && TRIPO_CDN_RE.test(url);
}

// Replicate signs its CDN URLs for ~1 hour. Like Tripo URLs they can't be
// trusted as a long-lived cache entry — they 404 once the signature
// expires.
const REPLICATE_CDN_RE = /https?:\/\/[^/]*replicate\.delivery\//i;
export function isReplicateCdnUrl(url) {
  return typeof url === 'string' && REPLICATE_CDN_RE.test(url);
}

// ─── Slug builder ─────────────────────────────────────────────────────────────
// Two cars sharing year/make/model/trim share a slug. Trim is optional — many
// VINs decode without one, in which case we drop it from the slug.
// Claim becomes re-claimable after 12 min. Must be > wait3DModel TIMEOUT
// below so the original generator's claim doesn't expire while it's still
// working — otherwise a second client would re-claim and double-spend.
const PENDING_STALE_MS = 12 * 60 * 1000;

function normSegment(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildModelSlug(vehicle) {
  if (!vehicle) return null;
  const { year, make, model, trim } = vehicle;
  if (!year || !make || !model) return null;
  const parts = [String(year), normSegment(make), normSegment(model)];
  const t = normSegment(trim);
  if (t) parts.push(t);
  parts.push(MODEL_VERSION);
  const slug = parts.join('-');
  // Final safety: strict pattern (matches the server-side regex)
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120 ? slug : null;
}

// ─── Tripo3D primitives (API v3) ──────────────────────────────────────────────
//
// Migrated from v2 → v3 in Aug 2026 (v2 is retired 2026-11-01). All three
// endpoint paths changed; the API key did not. Docs:
// https://developers.tripo3d.ai/en/docs/migration-v2-to-v3
//
//   v2                              →  v3 (via the /api/tripo proxy)
//   POST /upload                    →  POST /files
//   POST /task {type,...}           →  POST /generation/image-to-model {...}
//   GET  /task/{id}                 →  GET  /tasks/{id}
//
// The request/response shapes below were verified against the live v3 API at
// migration time (Aug 2026): /files returns data.file_token; image-to-model
// with { model, file: { type, file_token } } is accepted and returns a
// task_id; /tasks/{id} returns the { status, progress, output } envelope.
// The ONE thing that couldn't be observed is the populated `output` of a
// SUCCESSFUL task (the test job — a throwaway pixel with no credit — failed),
// so the GLB-URL field name in tripoPoll stays defensively multi-named.

// Generation model. v3 REQUIRES this field — omitting it 400s with
// "model is required, allowed values: P1-20260311, v2.5-20250123,
// v3.0-20250812, v3.1-20260211". v3.1 is the current v3-line model and is
// verified to accept our request; swap for 'P1-20260311' (newer flagship) if
// output quality needs a bump.
const TRIPO_MODEL = 'v3.1-20260211';

// Build the image-to-model request body. Verified accepted by the live v3 API:
// the v2 `file: { type, file_token }` object is unchanged; only the v2
// task-level `type: 'image_to_model'` discriminator is dropped (the endpoint
// path now implies it), and the required `model` is added.
function buildImageToModelBody(fileToken) {
  return { model: TRIPO_MODEL, file: { type: 'jpg', file_token: fileToken } };
}

async function tripoSubmitFromFile(imageBase64, imageMediaType) {
  const blob = await (await fetch(`data:${imageMediaType};base64,${imageBase64}`)).blob();
  const form = new FormData();
  form.append('file', blob, 'vehicle.jpg');

  // v3: POST /files (multipart, `file` field) — was /upload.
  const uploadRes = await fetch('/api/tripo/files', { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error(`Tripo upload failed: ${uploadRes.status}`);
  const uploaded = await uploadRes.json();
  // Token field name differs across versions/docs — accept either. v3 doc:
  // `file_token`; v2 returned `image_token`.
  const fileToken =
       uploaded?.data?.file_token
    || uploaded?.data?.image_token
    || uploaded?.data?.token;
  if (!fileToken) {
    throw new Error(
      `Tripo upload returned no file token (data keys: ${Object.keys(uploaded?.data || {}).join(', ') || 'none'})`,
    );
  }
  return tripoCreateTask(buildImageToModelBody(fileToken));
}

async function tripoCreateTask(body) {
  // v3: POST /generation/image-to-model — was POST /task with a `type` field.
  const res = await fetch('/api/tripo/generation/image-to-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tripo task failed: ${res.status}`);
  const { data: { task_id } } = await res.json();
  return task_id;
}

async function tripoPoll(taskId) {
  // v3: GET /tasks/{id} — was GET /task/{id}. Envelope ({ code, data }),
  // `status`/`progress`, and the `success` status value are unchanged.
  const res = await fetch(`/api/tripo/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Tripo poll failed: ${res.status}`);
  const { data } = await res.json();
  const out = data?.output ?? {};
  // The GLB URL field name has drifted across versions. v3 docs show
  // `model_url`; v2.5 used `pbr_model`; older used `model`. Accept any
  // non-empty URL in priority order so a successful job is never dropped as
  // 'no_url' just because the field was renamed.
  const glbUrl =
       out.model_url       // v3 (preferred)
    || out.pbr_model       // v2.5 textured GLB
    || out.model           // legacy textured GLB
    || out.base_model      // untextured base mesh fallback
    || out.glb             // some endpoints
    || null;
  if (data?.status === 'success') {
    dlog('tripoPoll success', { taskId, fieldsAvailable: Object.keys(out), glbUrl });
  }
  return { status: data?.status, progress: data?.progress ?? 0, glbUrl };
}

// Fetch a base64-encoded stock photo for a VIN via /api/vinaudit-images.
// Returns { base64, mediaType } that tripoSubmitFromFile can consume
// directly, or null if nothing usable came back. Replaces the older
// shape (which expected an image URL from /api/vinaudit — that endpoint
// is for market values, not images, and silently always returned null).
//
// Routes through the cached `fetchVinAuditImages` helper so the 3D
// pipeline benefits from the same L1 (in-session) + L2 (Firestore by
// year-make-model) cache as the Car Images tab. Vehicle metadata is
// optional but recommended — without it we still cache by VIN, but the
// cross-trim sharing benefit is lost.
async function fetchVinAuditPhoto(vin, vehicle = null) {
  if (!vin) return null;
  try {
    const images = await fetchVinAuditImages(vin, vehicle ? { vehicle } : {});
    const first = images?.[0];
    if (!first?.base64 || !first?.mediaType) return null;
    return { base64: first.base64, mediaType: first.mediaType };
  } catch {
    return null;
  }
}

// ─── Provider selection ──────────────────────────────────────────────────────
// Three image-to-3D backends are wired (priority order):
//   - 'replicate' (Replicate's firtoz/trellis) — DEFAULT, TRELLIS quality, ~$0.036/run
//   - 'tripo'     (Tripo3D)                    — automatic fallback when replicate fails
//   - 'trellis'   (NVIDIA-hosted TRELLIS NIM)  — playground demo only, do not use
//
// Replicate's firtoz/trellis is the same Microsoft TRELLIS model that
// NVIDIA's playground hosts, but with a real REST API that accepts
// user-uploaded images. ~88% cheaper than Tripo3D, comparable quality,
// 26s typical run time.
//
// On Replicate failure (network error, rate limit, model error) we
// automatically fall through to Tripo3D so users never see a broken
// state. Tripo3D was the original provider and remains fully wired as
// the safety net.
//
// NVIDIA's hosted TRELLIS at build.nvidia.com is a playground demo —
// its `image` field is hardcoded to 4 example_id values and rejects
// user uploads with HTTP 422 ("Expected: example_id, got: asset_id").
// The scaffolding is kept behind the 'trellis' flag but never default.
const DEFAULT_MODEL_PROVIDER = (process.env.REACT_APP_MODEL_PROVIDER || 'replicate').toLowerCase();

// Resolve the provider for a single generateOrFetch3D call. The caller
// can pass `providerOverride` from user preferences (stored in Firestore
// per account). 'auto' or any falsy value falls back to the build-time
// default, preserving central control while still letting individual
// users force a specific engine.
function resolveProvider(providerOverride) {
  const raw = String(providerOverride || '').toLowerCase();
  if (raw === 'tripo' || raw === 'replicate' || raw === 'trellis') return raw;
  return DEFAULT_MODEL_PROVIDER;
}

// ─── TRELLIS submit + wait ───────────────────────────────────────────────────
// Same shape as Tripo's submit/wait so generateOrFetch3D can use either
// provider transparently.
//
// taskId on the return value is the NVCF request ID; pass to waitTrellis().
async function trellisSubmit(imageBase64, mediaType) {
  const res = await fetch('/api/trellis/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mediaType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Log the FULL response including NVIDIA's upstream error body so we
    // can see the actual rejection reason in the browser console. Without
    // this we just see "trellis_error" which isn't actionable.
    dwarn('trellisSubmit non-OK', {
      status: res.status,
      error: body?.error,
      nvidiaStatus: body?.status,
      nvidiaBody: body?.body,
      full: body,
    });
    throw new Error(body?.error || `trellis_submit_${res.status}`);
  }
  const data = await res.json();
  // Sync path: NVIDIA returned the GLB inline. Wrap it as if it were a
  // taskId; waitTrellis() detects the sentinel and returns immediately.
  if (data.mode === 'sync') {
    return { taskId: `sync:${Math.random().toString(36).slice(2, 10)}`, _syncGlb: data.glbBase64 };
  }
  if (data.mode === 'async') {
    return { taskId: data.requestId };
  }
  throw new Error('trellis_unknown_mode');
}

async function waitTrellis(taskId, onProgress, signal, slug) {
  // Sync fast-path: submit already returned the GLB inline; the caller
  // stored it on the job object and we synthesize the same shape Tripo's
  // wait returns. (handled by caller — see generateOrFetch3D)
  const INTERVAL = 4000;
  const TIMEOUT = 5 * 60 * 1000; // TRELLIS is fast — 90s typical, 5min hard cap
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const res = await fetch(
        `/api/trellis/status?requestId=${encodeURIComponent(taskId)}&slug=${encodeURIComponent(slug || '')}`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === 'pending') {
        onProgress?.({ status: 'Running', progress: Math.min(95, ((Date.now() - start) / TIMEOUT) * 95) });
        continue;
      }
      if (data.status === 'ready' && data.glbUrl) {
        dlog('trellis ready', { slug, source: data.source, dev: data.dev });
        return { glbUrl: data.glbUrl, source: data.source, dev: data.dev };
      }
      if (data.status === 'failed') {
        dwarn('trellis failed', data);
        return null;
      }
    } catch (err) {
      dwarn('trellis poll threw', err);
      // keep trying — transient network errors are common during long polls
    }
  }
  dwarn('trellis wait timed out');
  return null;
}

// ─── Replicate (firtoz/trellis) submit + wait ─────────────────────────────────
// Same shape as Tripo's submit/wait so the orchestrator can use it
// transparently. The status endpoint relays the GLB to R2 server-side,
// so this returns a final R2 URL with no separate persist step.
async function replicateSubmit({ imageBase64, mediaType, imageUrl }) {
  const doFetch = () =>
    fetch('/api/replicate/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mediaType, imageUrl }),
    });

  let res = await doFetch();

  // Rate-limit retry: Replicate's 429 response carries `retry_after`
  // (seconds). When that's a small number, the right move is to wait
  // and retry once before falling through to Tripo3D — saves the Tripo
  // cost during transient rate-limit blips. We cap the wait at 12s so
  // a user's analysis isn't stalled for too long; longer rate-limit
  // windows fall through to Tripo immediately.
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    // The proxied body wraps Replicate's body as a string. Parse out
    // retry_after if present.
    let retryAfter = null;
    try {
      const inner = body?.body ? JSON.parse(body.body) : null;
      retryAfter = Number(inner?.retry_after);
    } catch {
      retryAfter = null;
    }
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 12) {
      dlog(`replicateSubmit got 429, retrying after ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250));
      res = await doFetch();
    } else {
      // Long wait or no retry_after — surface to caller, fall through to Tripo.
      dwarn('replicateSubmit 429 (no retry — too long or unspecified)', {
        retryAfter,
        body: body?.body,
      });
      throw new Error('replicate_rate_limited');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    dwarn('replicateSubmit non-OK', {
      status: res.status,
      error: body?.error,
      replicateStatus: body?.status,
      replicateBody: body?.body,
    });
    throw new Error(body?.error || `replicate_submit_${res.status}`);
  }
  const data = await res.json();
  if (!data.predictionId) throw new Error('replicate_no_prediction_id');
  return { predictionId: data.predictionId };
}

async function waitReplicate(predictionId, onProgress, signal, slug) {
  const INTERVAL = 3000; // Replicate runs in ~26s, so 3s poll is reasonable
  const TIMEOUT = 5 * 60 * 1000; // 5min hard cap — generous vs 26s typical
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const res = await fetch(
        `/api/replicate/status?predictionId=${encodeURIComponent(predictionId)}&slug=${encodeURIComponent(slug || '')}`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === 'pending') {
        onProgress?.({
          status: 'Running',
          progress: Math.min(95, ((Date.now() - start) / 60000) * 100), // rough % based on expected ~26s
        });
        continue;
      }
      if (data.status === 'ready' && data.glbUrl) {
        dlog('replicate ready', { slug, source: data.source, dev: data.dev });
        return { glbUrl: data.glbUrl, source: data.source, dev: data.dev };
      }
      if (data.status === 'failed') {
        dwarn('replicate failed', data);
        return null;
      }
    } catch (err) {
      dwarn('replicate poll threw', err);
      // Keep trying — transient network errors are common during long polls.
    }
  }
  dwarn('replicate wait timed out');
  return null;
}

// Full Replicate pipeline — submit, poll, mark slug ready in Firestore.
// Returns { glbUrl, slug, fromCache: false } on success, or null so the
// caller can fall back to Tripo3D.
async function runReplicatePipeline({
  slug, claim, prefetchedImage, vin, vehicle, onProgress, onCost, signal,
  // Legacy fields kept for backward compat if a caller bypasses generateOrFetch3D.
  images, imageBase64, imageMediaType,
}) {
  const img = prefetchedImage
    || (await resolveImageForGeneration({ images, imageBase64, imageMediaType, vin, vehicle, onCost }));
  if (!img) {
    dwarn('Replicate: no image to submit');
    return null;
  }
  onProgress?.({ status: 'Submitting', progress: 0 });

  let submitRes;
  try {
    submitRes = await replicateSubmit({ imageBase64: img.base64, mediaType: img.mediaType });
  } catch (err) {
    dwarn('Replicate submit threw', err);
    return null;
  }
  // Replicate firtoz/trellis pricing — $0.036/run as of writing. Adjust
  // here when their pricing changes.
  onCost?.({ label: 'Replicate TRELLIS (image-to-3D)', amount: 0.036, detail: `source: ${img.source}` });

  onProgress?.({ status: 'Pending', progress: 0 });
  if (slug && claim?.action === 'claim' && submitRes.predictionId) {
    // Tag prediction in localStorage so a refresh-during-poll can recover.
    // Reuses the Tripo recovery slot — `recordPendingJob` is provider-agnostic.
    recordPendingJob(slug, submitRes.predictionId, vin || null);
  }

  const result = await waitReplicate(submitRes.predictionId, onProgress, signal, slug || '');
  if (!result?.glbUrl) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'replicate_no_url');
      clearPendingJob(slug);
    }
    return null;
  }

  // Persist to Firestore. In prod, glbUrl is the R2 URL the status
  // endpoint produced — long-lived, fine to cache forever. In dev, it's
  // the Replicate CDN URL — usable for the session but not durable
  // (signed URLs from Replicate's CDN can expire), so we don't cache it.
  const isReplicateCdn = /replicate\.delivery/i.test(result.glbUrl) || /replicate\.com/i.test(result.glbUrl);
  if (slug && claim?.action === 'claim') {
    if (!isReplicateCdn) {
      // R2 URL — permanent. Cache forever.
      await markReady(slug, result.glbUrl, vin || null, { source: 'r2', modelProvider: 'replicate-trellis' });
      dlog('Replicate: markReady with R2 URL', { url: result.glbUrl.slice(0, 80) });
    } else if (process.env.NODE_ENV !== 'production') {
      // Dev — persist the Replicate URL with a SHORT expiry. Replicate
      // signs its CDN URLs for ~1 hour; we use 50 min to keep a safety
      // buffer against clock skew. After expiry, the slug re-claims and
      // regenerates — better than caching a URL that will 404 mid-render.
      const expiresAt = Date.now() + 50 * 60 * 1000;
      await markReady(slug, result.glbUrl, vin || null, { source: 'replicate', expiresAt, modelProvider: 'replicate-trellis' });
      dlog('Dev: markReady with Replicate URL + expiresAt');
    } else {
      // Prod somehow got a Replicate URL instead of R2 — means R2
      // misconfigured. Mark failed so the user sees fallback.
      await markFailed(slug, 'replicate_returned_cdn_url_in_prod');
    }
    clearPendingJob(slug);
  }

  return {
    glbUrl: maybeProxyForDev(result.glbUrl),
    slug,
    fromCache: false,
    modelProvider: 'replicate-trellis',
  };
}

// Resolve the input image for TRELLIS: prefer the user's photo (first
// entry in the `images` array), then a legacy single-image arg, then
// VinAudit's stock photo when only a VIN is available.
async function resolveImageForGeneration({ images, imageBase64, imageMediaType, vin, vehicle, onCost }) {
  if (Array.isArray(images) && images.length > 0) {
    const first = images.find((i) => i?.base64 && i?.mediaType);
    if (first) return { base64: first.base64, mediaType: first.mediaType, source: 'photo' };
  }
  if (imageBase64 && imageMediaType) {
    return { base64: imageBase64, mediaType: imageMediaType, source: 'photo' };
  }
  if (vin) {
    // Pass vehicle metadata so the L2 cache key is year-make-model-based
    // (cross-trim sharing) instead of VIN-only.
    const stock = await fetchVinAuditPhoto(vin, vehicle);
    if (stock) {
      onCost?.({ label: 'VinAudit (image lookup)', amount: 0.05, detail: 'stock photo for 3D' });
      return { base64: stock.base64, mediaType: stock.mediaType, source: 'vinaudit' };
    }
  }
  return null;
}

// Full TRELLIS generation flow — submit, poll, R2 relay, markReady.
// Returns { glbUrl, slug, fromCache: false } on success, or null to let
// the caller fall back to Tripo3D.
async function runTrellisPipeline({
  slug, claim, prefetchedImage, vin, vehicle, onProgress, onCost, signal,
  // Legacy fields kept for backward compat.
  images, imageBase64, imageMediaType,
}) {
  const img = prefetchedImage
    || (await resolveImageForGeneration({ images, imageBase64, imageMediaType, vin, vehicle, onCost }));
  if (!img) {
    dwarn('TRELLIS: no image to submit (no user photo + VinAudit returned none)');
    return null;
  }
  onProgress?.({ status: 'Submitting', progress: 0 });

  let submitRes;
  try {
    submitRes = await trellisSubmit(img.base64, img.mediaType);
  } catch (err) {
    dwarn('TRELLIS submit threw', err);
    return null;
  }
  // TRELLIS pricing — adjust once NVIDIA confirms per-call cost on your tier.
  onCost?.({ label: 'NVIDIA TRELLIS (image-to-3D)', amount: 0.25, detail: `source: ${img.source}` });

  // Sync path — submit returned the GLB inline. We still need to land it
  // in R2 so future users hit the cache. Hand it to /api/trellis/status as
  // if it were a completed async job. (In dev there's no R2, so we get a
  // data URL back — fine for the current session.)
  // For simplicity in this first pass, the sync inline-GLB path returns a
  // data URL only. R2 persistence for the sync case is a follow-up. The
  // overwhelmingly common case is async (30-90s).
  if (submitRes._syncGlb) {
    const dataUrl = `data:model/gltf-binary;base64,${submitRes._syncGlb}`;
    onProgress?.({ status: 'Done', progress: 100 });
    if (slug && claim?.action === 'claim') {
      // Don't persist a data URL to Firestore — too large + not durable.
      // Treat it like a one-session render.
      await markFailed(slug, 'trellis_sync_no_r2_persistence');
      clearPendingJob(slug);
    }
    return { glbUrl: dataUrl, slug, fromCache: false, modelProvider: 'nvidia-trellis' };
  }

  // Async path — poll status until ready. The status endpoint uploads to
  // R2 server-side and returns a permanent URL.
  onProgress?.({ status: 'Pending', progress: 0 });
  if (slug && claim?.action === 'claim' && submitRes.taskId) {
    recordPendingJob(slug, submitRes.taskId, vin || null);
  }
  const result = await waitTrellis(submitRes.taskId, onProgress, signal, slug || '');
  if (!result?.glbUrl) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'trellis_no_url');
      clearPendingJob(slug);
    }
    return null;
  }

  // Persist to Firestore. In prod, glbUrl is an R2 URL — long-lived,
  // permanent, fine to cache forever. In dev, it's a data URL — too large
  // for Firestore (1MB doc limit) so we just hand it back to the caller
  // without persistence.
  const isDataUrl = result.glbUrl.startsWith('data:');
  if (slug && claim?.action === 'claim') {
    if (!isDataUrl) {
      await markReady(slug, result.glbUrl, vin || null, { source: 'r2', modelProvider: 'nvidia-trellis' });
      dlog('TRELLIS: markReady with R2 URL', { url: result.glbUrl.slice(0, 80) });
    } else if (process.env.NODE_ENV === 'production') {
      await markFailed(slug, 'trellis_returned_data_url_in_prod');
    }
    clearPendingJob(slug);
  }

  return { glbUrl: result.glbUrl, slug, fromCache: false, modelProvider: 'nvidia-trellis' };
}

// ─── Tripo3D submit + wait (kept exported; legacy callers still work) ─────────

export async function submit3DJob(imageBase64, imageMediaType, vin) {
  // Multi-image support: callers can pass an array as the first arg
  // ([{ base64, mediaType }, ...]) and we'll pick the best candidate.
  // Tripo3D's image_to_model takes one image; if/when we wire up
  // multiview_to_model (which requires labeled front/back/left/right views),
  // this is where the routing would live.
  if (Array.isArray(imageBase64)) {
    const list = imageBase64.filter((i) => i && i.base64 && i.mediaType);
    if (list.length > 0) {
      const first = list[0];
      const taskId = await tripoSubmitFromFile(first.base64, first.mediaType);
      return { taskId, source: 'photo', imagesUsed: 1, imagesProvided: list.length };
    }
  } else if (imageBase64 && imageMediaType) {
    const taskId = await tripoSubmitFromFile(imageBase64, imageMediaType);
    return { taskId, source: 'photo' };
  }
  // No user-supplied image. Fall back to VinAudit stock photo (charged
  // per call — see vinAuditImages.js). VinAudit returns base64 directly,
  // so we feed it through the file path (not the URL path) — no extra
  // HTTP hop, no CORS concerns.
  if (vin) {
    const stock = await fetchVinAuditPhoto(vin);
    if (stock) {
      const taskId = await tripoSubmitFromFile(stock.base64, stock.mediaType);
      return { taskId, source: 'vinaudit' };
    }
  }
  return null;
}

export async function wait3DModel(taskId, onProgress, signal) {
  const INTERVAL = 4000;
  // Tripo3D image-to-3D commonly takes 2–7 minutes; allow 10 to absorb spikes.
  // PENDING_STALE_MS above must remain > this value.
  const TIMEOUT = 10 * 60 * 1000;
  const start = Date.now();
  let lastStatus = null;
  dlog('wait3DModel start', { taskId, timeoutMin: TIMEOUT / 60000 });
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) { dlog('wait3DModel aborted'); return null; }
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) { dlog('wait3DModel aborted (post-sleep)'); return null; }
    try {
      const { status, progress, glbUrl } = await tripoPoll(taskId);
      if (status !== lastStatus) {
        dlog('wait3DModel status', { status, progress, hasGlbUrl: !!glbUrl });
        lastStatus = status;
      }
      onProgress?.({ status, progress });
      if (status === 'success' && glbUrl) {
        dlog('wait3DModel resolved', { taskId, elapsedMs: Date.now() - start });
        return glbUrl;
      }
      if (status === 'success' && !glbUrl) {
        dwarn('wait3DModel: status=success but no glbUrl — Tripo response shape may have changed');
      }
      if (status === 'failed') {
        dwarn('wait3DModel: tripo reported failed');
        return null;
      }
    } catch (err) {
      dwarn('wait3DModel poll threw (will retry)', err);
    }
  }
  dwarn('wait3DModel timed out', { taskId, elapsedMs: Date.now() - start });
  return null;
}

// ─── Asset library (Firestore + R2) ───────────────────────────────────────────

// Tripo3D's CDN serves GLBs as AWS CloudFront signed URLs that expire after
// ~24 hours. We must NEVER trust one as a permanent cache entry — even if
// Firestore says status='ready', a Tripo URL that's a day old will 403.
//
// Two policies:
//   - PRODUCTION: persistGlbToR2 rewrites to R2, so a Tripo URL appearing on
//     a 'ready' doc means R2 is misconfigured. Reject it on read so the
//     procedural placeholder shows (no broken-modal). The slug re-claims and
//     re-runs Tripo, but at least nothing 403s in the user's face.
//   - DEV: no R2 binding, so Tripo URLs are the only thing we can cache.
//     Persist them with `glbUrlExpiresAt` (22h out) and accept them on read
//     until that timestamp passes. After expiry the doc gets re-claimed.
function isUsableCachedDoc(data) {
  if (!data || data.status !== 'ready' || !data.glbUrl) return false;
  // R2 (or any non-signed-CDN) URL — long-lived, always fine.
  if (!isTripoCdnUrl(data.glbUrl) && !isReplicateCdnUrl(data.glbUrl)) return true;
  // From here on it IS a signed CDN URL (Tripo or Replicate). Prod should
  // never cache these — production goes through R2.
  if (process.env.NODE_ENV === 'production') return false;
  // Dev: trust until the recorded expiry passes. Tripo writes 22h, Replicate
  // writes ~50min; either way the read-side just checks the stored value.
  const expiresAt = typeof data.glbUrlExpiresAt === 'number' ? data.glbUrlExpiresAt : 0;
  return Date.now() < expiresAt;
}

// Passive cache lookup — read-only, no claim, no generation. Use this when
// re-opening a previously analyzed report (e.g. clicking an old chat in the
// sidebar after a refresh) to surface the cached GLB without re-running
// Tripo3D. Returns null on any miss so the caller can fall through to the
// procedural placeholder cleanly.
export async function lookupCachedModel(vehicle) {
  const slug = buildModelSlug(vehicle);
  if (!slug) return null;
  const ref = doc(db, 'models3d', slug);

  // Firestore's WebChannel sometimes isn't connected the instant this fires
  // (page just loaded / auth just finished). The SDK then throws
  // code:'unavailable' "client is offline" — a transient state, not a real
  // network failure. One quick retry usually clears it; if it doesn't, we
  // fall through to attemptClaim's transaction, which forces a connection
  // and recovers on its own.
  const readOnce = () => getDoc(ref);
  let snap;
  try {
    snap = await readOnce();
  } catch (err) {
    if (err?.code === 'unavailable') {
      dlog('lookupCachedModel: transient offline, retrying once', { slug });
      await new Promise((r) => setTimeout(r, 250));
      try {
        snap = await readOnce();
      } catch (err2) {
        if (err2?.code === 'unavailable') {
          dlog('lookupCachedModel: still offline after retry — falling through to claim', { slug });
          return null;
        }
        dwarn('lookupCachedModel: read failed (after retry)', err2);
        return null;
      }
    } else {
      dwarn('lookupCachedModel: read failed', err);
      return null;
    }
  }

  if (!snap.exists()) {
    dlog('lookupCachedModel: no doc for slug', slug);
    return null;
  }
  const data = snap.data();
  if (!isUsableCachedDoc(data)) {
    dlog('lookupCachedModel: doc not usable', {
      slug,
      status: data.status,
      hasUrl: !!data.glbUrl,
      isTripo: isTripoCdnUrl(data.glbUrl),
      expiresAt: data.glbUrlExpiresAt,
    });
    return null;
  }
  dlog('lookupCachedModel: cache hit', { slug });
  return {
    glbUrl: maybeProxyForDev(data.glbUrl),
    slug,
    fromCache: true,
    modelProvider: data.modelProvider || null,
  };
}

async function attemptClaim(slug, vehicle) {
  const ref = doc(db, 'models3d', slug);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) {
        // In prod, never trust a stored Tripo URL — those CloudFront
        // signatures expire ~24h. In dev, allow them up to glbUrlExpiresAt
        // so cross-session cache works without R2.
        if (isUsableCachedDoc(data)) {
          return { action: 'cache_hit', glbUrl: data.glbUrl, modelProvider: data.modelProvider || null };
        }
        dlog('attemptClaim: ready doc not usable (expired Tripo or prod-Tripo), re-claiming', slug);
      }
      if (data.status === 'pending') {
        const claimedAt = data.claimedAt?.toMillis?.() ?? 0;
        const stale = Date.now() - claimedAt > PENDING_STALE_MS;
        if (!stale) return { action: 'wait' };
        // fall through and re-claim
      }
      // 'failed', stale 'pending', or 'ready' with an expired Tripo URL — re-claim
    }
    tx.set(ref, {
      status: 'pending',
      claimedAt: serverTimestamp(),
      version: MODEL_VERSION,
      year:  vehicle?.year ?? null,
      make:  vehicle?.make ?? null,
      model: vehicle?.model ?? null,
      trim:  vehicle?.trim ?? null,
    });
    return { action: 'claim' };
  });
}

async function pollCacheUntilReady(slug, signal) {
  const ref = doc(db, 'models3d', slug);
  // Should comfortably exceed wait3DModel TIMEOUT so a follower client doesn't
  // give up before the original generator finishes.
  const TIMEOUT = 12 * 60 * 1000;
  const INTERVAL = 4000;
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) {
        return { glbUrl: data.glbUrl, modelProvider: data.modelProvider || null };
      }
      if (data.status === 'failed') return null;
    } catch {
      // transient — keep polling
    }
  }
  return null;
}

async function persistGlbToR2(slug, sourceUrl) {
  dlog('persistGlbToR2 → POST /api/models/upload', { slug, sourceUrl: sourceUrl?.slice(0, 80) });
  let res;
  try {
    res = await fetch('/api/models/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, sourceUrl }),
    });
  } catch (err) {
    dwarn('persistGlbToR2 fetch threw (network or proxy down)', err);
    throw err;
  }
  if (!res.ok) {
    // Surface the response body when possible so we can tell apart a 404
    // (route missing — dev server not restarted) from a 502 (R2 upstream
    // failed) from a 400 (bad slug shape).
    let bodyText = '';
    try { bodyText = await res.text(); } catch {}
    dwarn('persistGlbToR2 non-OK response', {
      status: res.status,
      statusText: res.statusText,
      body: bodyText.slice(0, 200),
    });
    throw new Error(`models/upload failed: ${res.status}`);
  }
  const data = await res.json();
  dlog('persistGlbToR2 ok', data);
  return data?.glbUrl ?? null;
}

async function markReady(slug, glbUrl, sourceVin, opts = {}) {
  const patch = {
    status: 'ready',
    glbUrl,
    generatedAt: serverTimestamp(),
    sourceVin: sourceVin || null,
    glbUrlSource: opts.source || (isTripoCdnUrl(glbUrl) ? 'tripo' : 'r2'),
  };
  // modelProvider tracks the GENERATOR (tripo / replicate-trellis / nvidia-trellis),
  // separate from glbUrlSource which tracks the HOST (r2 / tripo CDN / replicate CDN).
  // Needed so the modal can show the user which provider built the model.
  if (opts.modelProvider) {
    patch.modelProvider = opts.modelProvider;
  }
  // expiresAt is only set for Tripo URLs in dev; R2 URLs never expire so
  // we explicitly omit the field rather than carrying a stale one over.
  if (typeof opts.expiresAt === 'number') {
    patch.glbUrlExpiresAt = opts.expiresAt;
  }
  try {
    await updateDoc(doc(db, 'models3d', slug), patch);
    dlog('markReady ok', { slug, fields: Object.keys(patch) });
  } catch (err) {
    // Loud + actionable. The most common cause is a Firestore-rules
    // mismatch — every new field added to the patch above must also be
    // whitelisted in the models3d security rule's hasOnly([...]). A
    // silent failure here leaves the slug doc stuck at status='pending',
    // so every future analysis of the same vehicle re-generates the 3D
    // model (paying the provider cost every time). Surface this fact
    // explicitly so the cause is obvious.
    const isPermission =
      err?.code === 'permission-denied' ||
      /insufficient permissions|permission/i.test(err?.message || '');
    // eslint-disable-next-line no-console
    console.error(
      isPermission
        ? '%c[models3d] markReady WRITE BLOCKED by Firestore rules — slug doc stays "pending" and every future view will re-generate this 3D model. Add the missing field(s) to the models3d rule\'s hasOnly([...]) whitelist.'
        : '%c[models3d] markReady failed — slug doc stays "pending" and every future view will re-generate this 3D model.',
      'color:#dc2626;font-weight:bold',
      { slug, patchFields: Object.keys(patch), err },
    );
  }
}

async function markFailed(slug, reason) {
  try {
    await updateDoc(doc(db, 'models3d', slug), {
      status: 'failed',
      failureReason: String(reason).slice(0, 200),
      failedAt: serverTimestamp(),
    });
  } catch {}
}

// ─── Refresh-resilient Tripo job recovery ───────────────────────────────────
// Tripo3D charges per submitted task, NOT per poll. So when a user refreshes
// mid-generation the cheap fix is NOT to abandon the task — it's to poll the
// SAME task_id on the next page load and pick up the result. If Tripo
// finished while we were gone, we get the GLB for free; if it's still
// running, we keep waiting.
//
// We persist the active task list to localStorage (per-tab, per-user, NOT
// shared across users — only the originating client knows the task_id).
// On next page load `recoverPendingJobs()` polls each entry and either
// markReady's the GLB or drops it.
//
// We deliberately do NOT mark the slug doc as failed on unload anymore.
// Letting it sit at status="pending" with a recoverable task_id is the only
// path that doesn't waste $0.30 every refresh.
const PENDING_JOBS_KEY = 'vincritiq_pending_3d_jobs_v1';
// Tripo task_ids stay valid roughly as long as the source images do — give
// ourselves 30 min to recover before we give up and re-claim.
const RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;

function readPendingJobs() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_JOBS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writePendingJobs(list) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PENDING_JOBS_KEY, JSON.stringify(list));
  } catch {}
}

function recordPendingJob(slug, taskId, vin) {
  if (!slug || !taskId) return;
  const list = readPendingJobs().filter((j) => j.slug !== slug);
  list.push({ slug, taskId, vin: vin || null, savedAt: Date.now() });
  writePendingJobs(list);
}

function clearPendingJob(slug) {
  if (!slug) return;
  writePendingJobs(readPendingJobs().filter((j) => j.slug !== slug));
}

/**
 * Resume any Tripo jobs that were interrupted by a previous page refresh.
 * Called once on app boot. For each saved task:
 *   - poll Tripo
 *   - if success → persist to R2 / markReady (+clear from localStorage)
 *   - if failed → markFailed (+clear)
 *   - if still running → leave it; we'll try again next boot
 *   - if older than RECOVERY_MAX_AGE_MS → drop the entry; next claim attempt
 *     will re-run Tripo from scratch
 *
 * Safe to call multiple times. Idempotent. Catches all errors so it can never
 * break the rest of the app boot.
 */
export async function recoverPendingJobs() {
  const list = readPendingJobs();
  if (list.length === 0) return;
  dlog('recoverPendingJobs: scanning', { count: list.length });

  for (const job of list) {
    const ageMs = Date.now() - (job.savedAt || 0);
    if (ageMs > RECOVERY_MAX_AGE_MS) {
      dlog('recoverPendingJobs: dropping aged entry', { slug: job.slug, ageMin: Math.round(ageMs / 60000) });
      clearPendingJob(job.slug);
      continue;
    }
    try {
      const { status, glbUrl } = await tripoPoll(job.taskId);
      dlog('recoverPendingJobs: poll result', { slug: job.slug, status, hasUrl: !!glbUrl });
      if (status === 'success' && glbUrl) {
        // Try to persist to R2; fall back to dev / markFailed branches the
        // same way generateOrFetch3D does.
        try {
          const r2Url = await persistGlbToR2(job.slug, glbUrl);
          if (r2Url) {
            await markReady(job.slug, r2Url, job.vin || null, { source: 'r2', modelProvider: 'tripo' });
            dlog('recoverPendingJobs: recovered with R2 URL', { slug: job.slug });
          } else if (process.env.NODE_ENV !== 'production') {
            const expiresAt = Date.now() + 22 * 60 * 60 * 1000;
            await markReady(job.slug, glbUrl, job.vin || null, { source: 'tripo', expiresAt, modelProvider: 'tripo' });
            dlog('recoverPendingJobs: recovered with Tripo URL (dev)', { slug: job.slug });
          } else {
            await markFailed(job.slug, 'recovery_r2_returned_null_in_prod');
          }
        } catch (err) {
          dwarn('recoverPendingJobs: persist threw', err);
          await markFailed(job.slug, 'recovery_persist_failed');
        }
        clearPendingJob(job.slug);
      } else if (status === 'failed') {
        await markFailed(job.slug, 'recovery_tripo_failed');
        clearPendingJob(job.slug);
      }
      // else: still running/queued — leave for the next boot.
    } catch (err) {
      dwarn('recoverPendingJobs: poll threw', err);
      // network blip — leave the entry, retry next time
    }
  }
}

// ─── Orchestrator: the new entry point ────────────────────────────────────────
//
// Use this from the chat flow instead of submit3DJob/wait3DModel directly.
// It handles the cache check, claim, generation, and R2 persistence.
//
// Args:
//   vehicle         { year, make, model, trim }   — for slug. If absent or
//                                                    incomplete, we skip caching
//                                                    and just generate per-session.
//   imageBase64,
//   imageMediaType  user-uploaded photo (optional, takes priority over VIN photo)
//   vin             VIN for VinAudit fallback path
//   onProgress      ({ status, progress }) → void
//   signal          AbortSignal
//
// Returns: { glbUrl, slug, fromCache } | null
//
export async function generateOrFetch3D({
  vehicle,
  imageBase64,
  imageMediaType,
  images,            // optional: array of { base64, mediaType }; takes precedence
  vin,
  onProgress,
  onCost,    // optional ({ label, amount, detail }) — fires once per paid event
  signal,
  providerOverride,  // 'auto' | 'tripo' | 'replicate' | 'trellis' from user prefs
} = {}) {
  const slug = buildModelSlug(vehicle);
  const effectiveProvider = resolveProvider(providerOverride);
  dlog('generateOrFetch3D start', {
    slug,
    hasUserPhoto: !!imageBase64,
    vin: vin || null,
    vehicle: vehicle ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim } : null,
    provider: effectiveProvider,
    providerOverride: providerOverride || null,
  });

  // 1. Cache lookup + claim (only if we have a slug)
  let claim = null;
  if (slug) {
    try {
      claim = await attemptClaim(slug, vehicle);
      dlog('attemptClaim →', claim);
    } catch (err) {
      // Firestore unavailable / rules block / offline — degrade to no-cache mode
      dwarn('attemptClaim threw — falling back to no-cache mode', err);
      claim = null;
    }

    if (claim?.action === 'cache_hit') {
      onProgress?.({ status: 'CacheHit', progress: 100 });
      dlog('cache hit — returning early', { slug, glbUrl: claim.glbUrl });
      // Cache hit — no costs incurred at all (no Tripo3D, no VinAudit image lookup).
      return {
        glbUrl: maybeProxyForDev(claim.glbUrl),
        slug,
        fromCache: true,
        modelProvider: claim.modelProvider || null,
      };
    }
    if (claim?.action === 'wait') {
      onProgress?.({ status: 'WaitingForOther', progress: 0 });
      dlog('claim is pending elsewhere, polling cache');
      const polled = await pollCacheUntilReady(slug, signal);
      if (polled?.glbUrl) {
        dlog('follower poll resolved', { glbUrl: polled.glbUrl });
        return {
          glbUrl: maybeProxyForDev(polled.glbUrl),
          slug,
          fromCache: true,
          modelProvider: polled.modelProvider || null,
        };
      }
      dwarn('follower poll exhausted — falling through to self-generate');
      // The other client failed — we fall through and try ourselves.
    }
  }

  // Resolve the input image AFTER the cache check (so cache hits never pay
  // for a VinAudit lookup) but BEFORE submitting to any provider. If there
  // is no user photo AND VinAudit has no coverage for this VIN, no generator
  // can produce a model — and the slug claim above would otherwise leave
  // an orphaned "pending" doc that other tabs would poll until it went
  // stale (10min). Bail out and explicitly markFailed so followers unblock.
  const prefetchedImage = await resolveImageForGeneration({
    images,
    imageBase64,
    imageMediaType,
    vin,
    vehicle,
    onCost,
  });
  if (!prefetchedImage) {
    dwarn('generateOrFetch3D: no source image available (no user photo + no VinAudit coverage) — skipping generation');
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'no_source_image');
    }
    return null;
  }

  // 2a. Provider switch — try the configured provider first. On failure
  //     (no GLB, network error, rate limit), fall through to Tripo3D as
  //     the automatic safety net so users never see a broken state.
  //
  //     Both 'replicate' and 'trellis' have their /status endpoint relay
  //     the GLB into R2 server-side, so there's no separate persist step
  //     on those paths — they return a final URL directly.
  if (effectiveProvider === 'replicate') {
    const replicateResult = await runReplicatePipeline({
      slug,
      claim,
      prefetchedImage,
      vin,
      vehicle,
      onProgress,
      onCost,
      signal,
    });
    if (replicateResult) return replicateResult;
    dwarn('Replicate returned no GLB — falling back to Tripo3D for this run');
    // fall through to Tripo flow below
  } else if (effectiveProvider === 'trellis') {
    const trellisResult = await runTrellisPipeline({
      slug,
      claim,
      prefetchedImage,
      vin,
      vehicle,
      onProgress,
      onCost,
      signal,
    });
    if (trellisResult) return trellisResult;
    dwarn('TRELLIS returned no GLB — falling back to Tripo3D for this run');
    // fall through to Tripo flow below
  }

  // 2b. Generate via Tripo3D. We already resolved the source image above
  //     (prefetchedImage), so feed it straight to submit3DJob as a one-entry
  //     array — this skips submit3DJob's internal VinAudit fetch and avoids
  //     double-charging the $0.05 lookup that resolveImageForGeneration
  //     already emitted.
  let job;
  try {
    job = await submit3DJob(
      [{ base64: prefetchedImage.base64, mediaType: prefetchedImage.mediaType }],
      null,
      null, // vin omitted: we don't want submit3DJob to fall through to VinAudit
    );
  } catch (err) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, err?.message || 'submit_failed');
    }
    return null;
  }
  if (!job) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'no_source_image');
    }
    return null;
  }
  // Costs are committed at submit time — Tripo doesn't refund failed jobs.
  // (VinAudit cost, if any, was already charged by resolveImageForGeneration
  // above — we don't re-charge here.)
  onCost?.({ label: 'Tripo3D image-to-3D', amount: 0.30, detail: `source: ${prefetchedImage.source}` });
  onProgress?.({ status: 'Pending', progress: 0 });

  // Record this Tripo task to localStorage IMMEDIATELY after submit so a
  // refresh-during-polling next page load can recover it (re-poll the same
  // task_id) instead of re-submitting and double-charging.
  if (slug && claim?.action === 'claim' && job.taskId) {
    recordPendingJob(slug, job.taskId, vin || null);
  }

  let tripoGlbUrl;
  try {
    tripoGlbUrl = await wait3DModel(job.taskId, onProgress, signal);
  } catch (err) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, err?.message || 'wait_failed');
      clearPendingJob(slug);
    }
    return null;
  }
  if (!tripoGlbUrl) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'tripo_no_url');
      clearPendingJob(slug);
    }
    return null;
  }

  dlog('Tripo returned glbUrl', { tripoGlbUrl: tripoGlbUrl.slice(0, 80) });

  // 3. Persist to R2 (only if we have a slug — i.e. we know the trim well enough to share)
  let finalUrl = tripoGlbUrl;
  if (slug && claim?.action === 'claim') {
    try {
      const r2Url = await persistGlbToR2(slug, tripoGlbUrl);
      if (r2Url) {
        finalUrl = r2Url;
        await markReady(slug, r2Url, vin || null, { source: 'r2', modelProvider: 'tripo' });
        dlog('R2 persist OK; markReady with R2 URL', { r2Url: r2Url.slice(0, 80) });
      } else if (process.env.NODE_ENV !== 'production') {
        // Dev mode (no R2 binding). Persist the raw Tripo URL with a 22h
        // expiry — that's the lifetime of Tripo's CloudFront signature, and
        // the read-side `isUsableCachedDoc` will reject it once we cross
        // glbUrlExpiresAt. This makes cross-session cache work in dev: a
        // second analysis of the same year/make/model/trim within the day
        // hits the slug doc and reuses the GLB instead of re-running Tripo.
        const expiresAt = Date.now() + 22 * 60 * 60 * 1000;
        await markReady(slug, tripoGlbUrl, vin || null, { source: 'tripo', expiresAt, modelProvider: 'tripo' });
        dlog('Dev: markReady with Tripo URL + expiresAt', {
          tripoUrl: tripoGlbUrl.slice(0, 80),
          expiresInH: 22,
        });
      } else {
        // Production with R2 returning null = MODELS_PUBLIC_BASE missing.
        // Persist nothing; mark failed so the next request re-claims and the
        // user sees the procedural fallback rather than a guaranteed-CORS
        // error from a Tripo URL.
        await markFailed(slug, 'r2_returned_null_in_prod');
        dlog('Prod: R2 returned null — MODELS_PUBLIC_BASE likely unset; marked failed');
      }
    } catch (err) {
      dwarn('R2 persist threw; falling back to Tripo URL for this session', err);
      // Don't markFailed — the URL still works for *this* session, and the next
      // run will re-attempt. We do release the claim so others can re-try.
      try {
        await updateDoc(doc(db, 'models3d', slug), {
          status: 'failed',
          failureReason: 'r2_upload_failed',
          failedAt: serverTimestamp(),
        });
      } catch {}
    }
    // Generation finished (success or terminal failure) — drop the
    // localStorage recovery entry so we don't re-poll a finalized task on
    // the next page load.
    clearPendingJob(slug);
  }

  // Final URL the caller hands to <GLBScene>. In production this is an R2
  // URL that loads cleanly. In dev (where finalUrl is the raw Tripo URL)
  // route through the dev proxy so the browser doesn't bounce on CORS.
  const displayUrl = maybeProxyForDev(finalUrl);
  dlog('generateOrFetch3D returning', {
    fromCache: false,
    finalUrl: finalUrl?.slice(0, 80),
    displayUrl: displayUrl?.slice(0, 80),
    proxiedForDev: displayUrl !== finalUrl,
    slug,
  });
  return { glbUrl: displayUrl, slug, fromCache: false, modelProvider: 'tripo' };
}
