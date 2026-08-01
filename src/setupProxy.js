// Local dev proxy — mirrors the Cloudflare Pages Functions in /functions/api/.
// The dev server injects the API keys server-side so the browser never sees them,
// matching production behavior. Reads keys from .env (no REACT_APP_ prefix preferred,
// but falls back to the legacy REACT_APP_*_API_KEY names so existing .env works).
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const { Readable } = require('node:stream');

// Accept multiple env-var spellings so production (Cloudflare Pages bindings)
// and local .env can use whichever convention. The first non-empty wins.
const pickEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '') return v.trim();
  }
  return undefined;
};
const CLAUDE_KEY        = pickEnv('CLAUDE_API_KEY', 'CLAUDE_KEY', 'REACT_APP_CLAUDE_API_KEY');
const TRIPO_KEY         = pickEnv('TRIPO_KEY', 'TRIPO_API_KEY', 'REACT_APP_TRIPO_API_KEY');
const VINAUDIT_KEY      = pickEnv('VINAUDIT_KEY', 'VINAUDIT_API_KEY', 'REACT_APP_VINAUDIT_API_KEY');
const VINCARIO_KEY      = pickEnv('VINCARIO_KEY');
const VINCARIO_SECRET   = pickEnv('VINCARIO_SECRET');
const STRIPE_SECRET_KEY     = pickEnv('STRIPE_SECRET_KEY');
const PUBLIC_BASE_URL       = pickEnv('PUBLIC_BASE_URL') || 'http://localhost:3000';
const NVIDIA_TRELLIS_KEY    = pickEnv('NVIDIA_TRELLIS_API_KEY', 'NVIDIA_API_KEY');
const REPLICATE_API_TOKEN   = pickEnv('REPLICATE_API_TOKEN');
const AUTODEV_KEY           = pickEnv('AUTODEV_API_KEY', 'AUTODEV_KEY');

// Startup banner — confirms which keys actually loaded into this process.
// Prints first/last 4 chars + length so you can eyeball it without leaking
// the secret. If a key shows "MISSING", the dev server didn't see it in
// .env at start time; restart `npm start` after editing .env.
const fingerprint = (k) => {
  if (!k) return 'MISSING';
  const s = String(k).trim();
  return `${s.slice(0, 4)}…${s.slice(-4)} (len ${s.length})`;
};
console.log('[setupProxy] keys loaded:');
console.log('  CLAUDE_KEY     :', fingerprint(CLAUDE_KEY));
console.log('  TRIPO_KEY      :', fingerprint(TRIPO_KEY));
console.log('  VINAUDIT_KEY   :', fingerprint(VINAUDIT_KEY));
console.log('  VINCARIO_KEY   :', fingerprint(VINCARIO_KEY));
console.log('  VINCARIO_SECRET:', fingerprint(VINCARIO_SECRET));
console.log('  STRIPE_SECRET  :', fingerprint(STRIPE_SECRET_KEY));
console.log('  NVIDIA_TRELLIS :', fingerprint(NVIDIA_TRELLIS_KEY));
console.log('  REPLICATE_TOKEN:', fingerprint(REPLICATE_API_TOKEN));
console.log('  AUTODEV_KEY    :', fingerprint(AUTODEV_KEY));

const stripBrowserHeaders = (proxyReq) => {
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
  proxyReq.removeHeader('sec-fetch-site');
  proxyReq.removeHeader('sec-fetch-mode');
  proxyReq.removeHeader('sec-fetch-dest');
  proxyReq.removeHeader('sec-fetch-user');
};

module.exports = function (app) {
  // Claude (Anthropic Messages) — server adds x-api-key & anthropic-version.
  // We capture and log the upstream body for any non-2xx response so we can
  // tell apart 400 (oversized image / bad payload), 401 (bad key), 413
  // (request too large), 529 (overloaded), etc. The successful streaming
  // path is left completely untouched.
  app.use(
    '/api/claude',
    createProxyMiddleware({
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      pathRewrite: { '^/api/claude': '/v1/messages' },
      onProxyReq: (proxyReq, req) => {
        stripBrowserHeaders(proxyReq);
        if (CLAUDE_KEY) proxyReq.setHeader('x-api-key', CLAUDE_KEY);
        proxyReq.setHeader('anthropic-version', '2023-06-01');
        // Mirror functions/api/claude.js: the client declares which betas its
        // request body needs via x-anthropic-beta, and the proxy promotes it
        // to the real header. Without this, a body field gated behind a beta
        // (e.g. `fallbacks`) 400s in dev while working in production.
        const betas = req.headers['x-anthropic-beta'];
        if (betas) proxyReq.setHeader('anthropic-beta', betas);
        proxyReq.removeHeader('x-anthropic-beta');
      },
      onProxyRes: (proxyRes, req) => {
        if (proxyRes.statusCode >= 400) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 600);
            console.warn(`[claude←] ${req.method} ${req.url}  status: ${proxyRes.statusCode}\n         body: ${body}`);
          });
        }
      },
    })
  );

  // Tripo3D — catch-all; server adds Authorization: Bearer
  app.use(
    '/api/tripo',
    createProxyMiddleware({
      target: 'https://api.tripo3d.ai',
      changeOrigin: true,
      pathRewrite: { '^/api/tripo': '/v2/openapi' },
      onProxyReq: (proxyReq, req) => {
        stripBrowserHeaders(proxyReq);
        if (TRIPO_KEY) {
          proxyReq.setHeader('Authorization', `Bearer ${TRIPO_KEY}`);
          console.log(`[tripo→] ${req.method} ${req.url}  auth: attached (key ${fingerprint(TRIPO_KEY)})`);
        } else {
          console.warn(`[tripo→] ${req.method} ${req.url}  auth: MISSING — TRIPO_KEY not loaded; request will 401`);
        }
      },
      onProxyRes: (proxyRes, req) => {
        if (proxyRes.statusCode >= 400) {
          // Surface the upstream body for failed Tripo requests so we can tell
          // 401 (bad key) from 402 (out of credits) from 400 (bad payload).
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 400);
            console.warn(`[tripo←] ${req.method} ${req.url}  status: ${proxyRes.statusCode}\n         body: ${body}`);
          });
        }
      },
    })
  );

  // Vincario — mirrors functions/api/vincario.js. Computes SHA1 control sum,
  // fetches vindecoder.eu, normalizes to the same JSON shape the client expects.
  app.get('/api/vincario', async (req, res) => {
    const vin = String(req.query.vin || '').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      return res.status(400).json({ error: 'valid 17-char vin required' });
    }
    if (!VINCARIO_KEY || !VINCARIO_SECRET) {
      // Return 200 (not 501) so the browser doesn't log a red error in the
      // console. The decoder reads `available: false` and gracefully falls
      // back to NHTSA. Vincario is an optional upgrade — NHTSA is the
      // primary path and is always free.
      return res.json({ available: false, reason: 'vincario_not_configured' });
    }
    try {
      const action = 'decode';
      const raw = `${vin}|${action}|${VINCARIO_KEY}|${VINCARIO_SECRET}`;
      const controlSum = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
      const upstream = `https://api.vindecoder.eu/3.2/${VINCARIO_KEY}/${controlSum}/${action}/${vin}.json`;
      const r = await fetch(upstream);
      if (!r.ok) return res.status(502).json({ error: 'vincario_upstream_failed', status: r.status });
      const data = await r.json();
      const decode = Array.isArray(data?.decode) ? data.decode : [];
      const byLabel = {};
      for (const d of decode) if (d?.label) byLabel[d.label] = d.value;
      const pick = (...keys) => { for (const k of keys) if (byLabel[k]) return byLabel[k]; return null; };
      res.json({
        source: 'vincario',
        vin,
        year: pick('Model Year', 'Production Year'),
        make: pick('Make'),
        model: pick('Model'),
        trim: pick('Trim', 'Trim 2'),
        series: pick('Series', 'Series 2'),
        bodyClass: pick('Body', 'Body Type', 'Body Class'),
        doors: pick('Number of Doors', 'Doors'),
        driveType: pick('Drive', 'Drive Type'),
        transmission: pick('Transmission', 'Transmission Type'),
        cylinders: pick('Number of Cylinders', 'Cylinders'),
        displacement: pick('Engine Displacement (ccm)', 'Displacement (L)', 'Displacement'),
        fuel: pick('Fuel Type - Primary', 'Fuel Type'),
        enginePower: pick('Engine Power (HP)', 'Engine Power'),
        plantCountry: pick('Plant Country'),
        manufacturer: pick('Manufacturer'),
        raw: byLabel,
      });
    } catch (err) {
      res.status(500).json({ error: 'vincario_dev_proxy_failed', message: String(err?.message || err) });
    }
  });

  // Models (R2 GLB asset library) — mirrors functions/api/models/upload.js.
  // In dev there's no R2 binding, so we don't actually persist the GLB; we just
  // tell the orchestrator that no public URL was produced. It then falls back to
  // using the original Tripo3D URL for the current session (no caching benefit
  // in dev, but the modal still renders the model end-to-end).
  app.post('/api/models/upload', async (req, res) => {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return res.status(400).json({ error: 'invalid_json' });
      }
    }
    const { slug, sourceUrl } = body || {};
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
      return res.status(400).json({ error: 'invalid_slug' });
    }
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'invalid_source_url' });
    }
    return res.json({ glbUrl: null, key: `models/${slug}.glb`, bytes: null, dev: true });
  });

  app.get('/api/models/upload', (_req, res) => {
    res.json({ exists: false, reason: 'dev_no_bucket' });
  });

  // Dev-only GLB CORS bypass.
  //
  // Tripo3D's CDN (tripo-data.rg1.data.tripo3d.com) doesn't send
  // Access-Control-Allow-Origin, so a browser fetch from localhost is
  // blocked. In production this never happens — R2 + our custom domain
  // (models.vincritiq.com) has CORS configured. In dev we tunnel the
  // request through the dev server so the browser sees a same-origin
  // response with permissive CORS headers.
  //
  // Only Tripo CDN hosts are allow-listed here so this can't be turned
  // into an SSRF that pulls arbitrary URLs.
  app.get('/dev-glb-proxy', async (req, res) => {
    const url = String(req.query.url || '');
    if (!/^https:\/\/[a-z0-9-]+\.(?:rg1\.)?data\.tripo3d\.com\//i.test(url)) {
      return res.status(400).json({ error: 'invalid_or_disallowed_url' });
    }
    try {
      const upstream = await fetch(url);
      if (!upstream.ok) {
        console.warn('[dev-glb-proxy] upstream non-OK', { status: upstream.status, url });
        return res.status(upstream.status).end();
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'model/gltf-binary');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.warn('[dev-glb-proxy] fetch threw', err);
      res.status(502).json({ error: 'upstream_failed', message: String(err?.message || err) });
    }
  });

  // ── Stripe (dev) ──────────────────────────────────────────────────
  // Mirrors functions/api/stripe/* in production. We proxy directly to
  // api.stripe.com with the dev STRIPE_SECRET_KEY (use a sk_test_ key in
  // your .env). The webhook is intentionally NOT wired in dev — use the
  // Stripe CLI's `stripe listen --forward-to localhost:3000/api/stripe/webhook`
  // to test webhooks locally.
  const ensureStripe = (res) => {
    if (!STRIPE_SECRET_KEY) {
      res.status(503).json({ error: 'Stripe is not configured (set STRIPE_SECRET_KEY in .env).' });
      return false;
    }
    return true;
  };

  const readJsonBody = async (req) => {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { return null; }
  };

  app.post('/api/stripe/create-checkout-session', async (req, res) => {
    if (!ensureStripe(res)) return;
    const body = await readJsonBody(req);
    if (!body) return res.status(400).json({ error: 'invalid_json' });
    const { uid, email, priceId, planId } = body;
    if (!uid || !priceId) return res.status(400).json({ error: 'uid and priceId are required' });

    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('client_reference_id', uid);
    if (email) params.append('customer_email', email);
    params.append('success_url', `${PUBLIC_BASE_URL}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${PUBLIC_BASE_URL}/?stripe=cancelled`);
    params.append('allow_promotion_codes', 'true');
    if (planId) params.append('metadata[planId]', planId);
    params.append('metadata[uid]', uid);

    try {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.warn('[stripe←] create-checkout-session', r.status, data?.error?.message);
        return res.status(r.status).json({ error: data?.error?.message || `Stripe ${r.status}` });
      }
      res.json({ url: data.url, id: data.id });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post('/api/stripe/create-portal-session', async (req, res) => {
    if (!ensureStripe(res)) return;
    const body = await readJsonBody(req);
    if (!body) return res.status(400).json({ error: 'invalid_json' });
    const { customerId, uid } = body;
    if (!customerId) return res.status(400).json({ error: 'No active subscription found.' });
    if (!uid) return res.status(400).json({ error: 'uid is required' });

    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', `${PUBLIC_BASE_URL}/?stripe=portal-return`);

    try {
      const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.warn('[stripe←] create-portal-session', r.status, data?.error?.message);
        return res.status(r.status).json({ error: data?.error?.message || `Stripe ${r.status}` });
      }
      res.json({ url: data.url });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.get('/api/stripe/verify-session', async (req, res) => {
    if (!ensureStripe(res)) return;
    const sessionId = String(req.query.session_id || '');
    const uid = String(req.query.uid || '');
    if (!sessionId || !uid) return res.status(400).json({ ok: false, error: 'session_id and uid are required' });

    try {
      const r = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
        { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } },
      );
      const session = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ ok: false, error: session?.error?.message || `Stripe ${r.status}` });

      if (session.client_reference_id !== uid && session?.metadata?.uid !== uid) {
        return res.status(403).json({ ok: false, error: 'Session does not belong to this user.' });
      }
      const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      const subStatus = typeof session.subscription === 'object' ? session.subscription?.status : null;
      const subActive = !subStatus || subStatus === 'active' || subStatus === 'trialing';
      if (!paid || !subActive) {
        return res.status(402).json({ ok: false, error: `Payment not completed (status: ${session.payment_status}).` });
      }
      res.json({
        ok: true,
        planId: session?.metadata?.planId || null,
        customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // NVIDIA TRELLIS — mirrors functions/api/trellis/{submit,status}.js.
  // In dev there's no R2 binding, so the status endpoint can't persist the
  // GLB to a permanent URL. Instead it returns the GLB as a data URL the
  // client can render directly for the current session (no cache across
  // refresh, which matches existing Tripo dev behavior).
  const TRELLIS_ENDPOINT = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
  const NVCF_STATUS_BASE = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

  const extractGlbBase64 = (data) => {
    if (!data) return null;
    if (Array.isArray(data.artifacts) && data.artifacts.length > 0) {
      const a = data.artifacts[0];
      return a.base64 || a.b64 || a.data || null;
    }
    if (Array.isArray(data.assets) && data.assets.length > 0) {
      const a = data.assets[0];
      return a.base64 || a.b64 || a.data || null;
    }
    if (data.output && typeof data.output === 'object') {
      return data.output.glb_b64 || data.output.b64_json || data.output.data || null;
    }
    return data.glb_b64 || data.b64_json || data.data || data.model_b64 || null;
  };

  const NVCF_ASSETS_ENDPOINT = 'https://api.nvcf.nvidia.com/v2/nvcf/assets';

  // Helper: upload binary image to NVCF asset store (Node.js equivalent of
  // the Workers helper in functions/api/trellis/submit.js).
  async function uploadNvcfAsset({ imageBytes, mediaType, description }) {
    const metaResp = await fetch(NVCF_ASSETS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NVIDIA_TRELLIS_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        contentType: mediaType,
        description: description || 'VinCritiq vehicle image',
      }),
    });
    if (!metaResp.ok) {
      const body = await metaResp.text().catch(() => '');
      throw new Error(`nvcf_asset_meta_${metaResp.status}: ${body.slice(0, 200)}`);
    }
    const meta = await metaResp.json();
    if (!meta?.assetId || !meta?.uploadUrl) throw new Error('nvcf_asset_meta_missing_fields');
    const putResp = await fetch(meta.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mediaType,
        'x-amz-meta-nvcf-asset-description': description || 'VinCritiq vehicle image',
      },
      body: imageBytes,
    });
    if (!putResp.ok) {
      const body = await putResp.text().catch(() => '');
      throw new Error(`nvcf_asset_put_${putResp.status}: ${body.slice(0, 200)}`);
    }
    return meta.assetId;
  }

  app.post('/api/trellis/submit', async (req, res) => {
    if (!NVIDIA_TRELLIS_KEY) {
      return res.status(500).json({ error: 'NVIDIA_TRELLIS_API_KEY not configured (set it in .env)' });
    }
    const body = await readJsonBody(req);
    if (!body) return res.status(400).json({ error: 'invalid_json' });
    const { imageBase64, mediaType = 'image/png', seed = 0, noTexture = false } = body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
    const clean = String(imageBase64).replace(/^data:[^,]+,/, '');

    // TRELLIS requires images uploaded as NVCF assets — inline base64
    // returns 422. Upload first, then reference the asset_id in the
    // inference request (with the matching NVCF-INPUT-ASSET-REFERENCES
    // header).
    let assetId;
    try {
      const imageBytes = Buffer.from(clean, 'base64');
      assetId = await uploadNvcfAsset({
        imageBytes,
        mediaType,
        description: 'VinCritiq vehicle image for TRELLIS',
      });
    } catch (err) {
      console.warn('[trellis←] asset upload failed', err.message);
      return res.status(502).json({ error: 'nvcf_asset_upload_failed', message: String(err?.message || err) });
    }

    try {
      const r = await fetch(TRELLIS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NVIDIA_TRELLIS_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'NVCF-INPUT-ASSET-REFERENCES': assetId,
        },
        body: JSON.stringify({
          mode: 'image',
          image: `data:${mediaType};asset_id,${assetId}`,
          output_format: 'glb',
          no_texture: noTexture,
          samples: 1,
          seed,
        }),
      });

      if (r.status === 202) {
        const requestId = r.headers.get('nvcf-reqid') || r.headers.get('NVCF-REQID');
        if (!requestId) return res.status(502).json({ error: 'no_request_id' });
        return res.json({ mode: 'async', requestId });
      }
      if (r.status === 200) {
        const data = await r.json().catch(() => null);
        const glbBase64 = extractGlbBase64(data);
        if (!glbBase64) {
          console.warn('[trellis←] 200 but no GLB found. Sample keys:', Object.keys(data || {}));
          return res.status(502).json({ error: 'no_glb_in_response' });
        }
        return res.json({ mode: 'sync', glbBase64 });
      }
      const errBody = await r.text().catch(() => '');
      console.warn('[trellis←] error', r.status, errBody.slice(0, 2000));
      return res.status(r.status >= 500 ? 502 : r.status).json({ error: 'trellis_error', status: r.status, body: errBody.slice(0, 2000) });
    } catch (err) {
      console.warn('[trellis←] fetch threw', err);
      return res.status(502).json({ error: 'nvidia_fetch_failed', message: String(err?.message || err) });
    }
  });

  app.get('/api/trellis/status', async (req, res) => {
    if (!NVIDIA_TRELLIS_KEY) {
      return res.status(500).json({ error: 'NVIDIA_TRELLIS_API_KEY not configured' });
    }
    const requestId = String(req.query.requestId || '');
    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    try {
      const r = await fetch(`${NVCF_STATUS_BASE}/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${NVIDIA_TRELLIS_KEY}`, Accept: 'application/json' },
      });
      if (r.status === 202) return res.json({ status: 'pending' });
      if (r.status === 404) return res.json({ status: 'failed', reason: 'request_not_found' });
      if (r.status >= 500) return res.json({ status: 'pending', _transient: true });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.json({ status: 'failed', reason: `nvidia_${r.status}`, body: body.slice(0, 300) });
      }
      const data = await r.json().catch(() => null);
      const glbBase64 = extractGlbBase64(data);
      if (!glbBase64) return res.json({ status: 'failed', reason: 'no_glb_in_response' });
      // Dev has no R2 — return the GLB inline as a data URL the client can
      // render. No cross-session caching in dev (matches Tripo dev behavior).
      const dataUrl = `data:model/gltf-binary;base64,${glbBase64}`;
      return res.json({ status: 'ready', glbUrl: dataUrl, source: 'trellis', dev: true });
    } catch (err) {
      return res.json({ status: 'pending', _transient: true, error: String(err?.message || err) });
    }
  });

  // Replicate (firtoz/trellis) — mirrors functions/api/replicate/*.js.
  // In dev there's no R2 binding, so status returns the Replicate CDN URL
  // directly. The browser loads from Replicate's signed URL which has
  // permissive CORS, so this works without a proxy hop.
  // firtoz/trellis is a community model — has to use the version-pinned
  // /v1/predictions endpoint, not the official-models /v1/models/.../predictions.
  // Override REPLICATE_TRELLIS_VERSION in .env to roll forward.
  const REPLICATE_PREDICT = 'https://api.replicate.com/v1/predictions';
  const DEFAULT_TRELLIS_VERSION = 'e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c';
  const TRELLIS_VERSION = pickEnv('REPLICATE_TRELLIS_VERSION') || DEFAULT_TRELLIS_VERSION;

  const findGlbUrl = (output) => {
    if (!output) return null;
    if (typeof output === 'string') return /\.glb(\?|$)/i.test(output) ? output : null;
    if (Array.isArray(output)) return output.find((u) => typeof u === 'string' && /\.glb(\?|$)/i.test(u)) || null;
    if (typeof output === 'object') {
      const candidates = [output.model_file, output.glb, output.glb_url, output.mesh, output.output_glb];
      for (const c of candidates) if (typeof c === 'string' && c) return c;
      for (const v of Object.values(output)) if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
    }
    return null;
  };

  app.post('/api/replicate/predict', async (req, res) => {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured (set it in .env)' });
    }
    const body = await readJsonBody(req);
    if (!body) return res.status(400).json({ error: 'invalid_json' });

    const {
      imageBase64,
      mediaType = 'image/png',
      imageUrl,
      seed = 0,
      textureSize = 1024,
      meshSimplify = 0.95,
      generateColor = true,
      generateModel = true,
      generateNormal = false,
      ssSamplingSteps = 12,
      slatSamplingSteps = 12,
      ssGuidanceStrength = 7.5,
      slatGuidanceStrength = 3.0,
    } = body;

    let image;
    if (imageUrl && /^https?:\/\//.test(imageUrl)) {
      image = imageUrl;
    } else if (imageBase64) {
      const clean = String(imageBase64).replace(/^data:[^,]+,/, '');
      image = `data:${mediaType};base64,${clean}`;
    } else {
      return res.status(400).json({ error: 'imageUrl or imageBase64 required' });
    }

    try {
      const r = await fetch(REPLICATE_PREDICT, {
        method: 'POST',
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: TRELLIS_VERSION,
          input: {
            // firtoz/trellis expects an `images` array, not a single
            // `image` field. Sending the singular form gets HTTP 422
            // with "images is required".
            images: [image],
            seed,
            texture_size: textureSize,
            mesh_simplify: meshSimplify,
            generate_color: generateColor,
            generate_model: generateModel,
            generate_normal: generateNormal,
            randomize_seed: seed === 0,
            ss_sampling_steps: ssSamplingSteps,
            slat_sampling_steps: slatSamplingSteps,
            ss_guidance_strength: ssGuidanceStrength,
            slat_guidance_strength: slatGuidanceStrength,
          },
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data) {
        console.warn('[replicate←] predict error', r.status, data && JSON.stringify(data).slice(0, 500));
        return res.status(r.status >= 500 ? 502 : r.status).json({
          error: 'replicate_error',
          status: r.status,
          body: data ? JSON.stringify(data).slice(0, 1500) : 'no_body',
        });
      }
      if (!data.id) {
        return res.status(502).json({ error: 'no_prediction_id', body: JSON.stringify(data).slice(0, 500) });
      }
      res.json({ predictionId: data.id, status: data.status, self: data.urls?.get || null });
    } catch (err) {
      console.warn('[replicate←] predict threw', err);
      res.status(502).json({ error: 'replicate_fetch_failed', message: String(err?.message || err) });
    }
  });

  app.get('/api/replicate/status', async (req, res) => {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });
    }
    const predictionId = String(req.query.predictionId || '');
    if (!predictionId) return res.status(400).json({ error: 'predictionId required' });

    try {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`, {
        headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, Accept: 'application/json' },
      });
      if (r.status === 404) return res.json({ status: 'failed', reason: 'prediction_not_found' });
      if (r.status >= 500) return res.json({ status: 'pending', _transient: true });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.json({ status: 'failed', reason: `replicate_${r.status}`, body: body.slice(0, 300) });
      }
      const data = await r.json().catch(() => null);
      if (!data) return res.json({ status: 'failed', reason: 'invalid_payload' });

      if (data.status === 'starting' || data.status === 'processing') {
        return res.json({ status: 'pending', replicateStatus: data.status });
      }
      if (data.status === 'failed' || data.status === 'canceled') {
        return res.json({ status: 'failed', reason: data.error || `replicate_${data.status}` });
      }
      if (data.status !== 'succeeded') {
        return res.json({ status: 'pending', replicateStatus: data.status });
      }
      const glbUrl = findGlbUrl(data.output);
      if (!glbUrl) {
        return res.json({
          status: 'failed',
          reason: 'no_glb_in_output',
          outputSample: typeof data.output === 'string' ? data.output.slice(0, 200) : Object.keys(data.output || {}),
        });
      }
      // Dev — no R2. Return the Replicate CDN URL directly; it has open
      // CORS, so the browser can load it for the current session. No
      // cross-session caching in dev (matches Tripo dev behavior).
      return res.json({ status: 'ready', glbUrl, source: 'replicate-trellis', dev: true });
    } catch (err) {
      return res.json({ status: 'pending', _transient: true, error: String(err?.message || err) });
    }
  });

  // VinAudit Vehicle Images — mirrors functions/api/vinaudit-images.js.
  // Returns base64-encoded images that the Tripo pipeline can feed directly
  // (no separate URL fetch round-trip). Same env-var fallback as the
  // market-value endpoint.
  app.get('/api/vinaudit-images', async (req, res) => {
    if (!VINAUDIT_KEY) {
      return res.status(500).json({ error: 'VINAUDIT key not configured (set VINAUDIT_API_KEY in .env)' });
    }
    const vin = String(req.query.vin || '').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      return res.status(400).json({ error: 'valid 17-char vin required' });
    }
    const params = new URLSearchParams({
      vin,
      key: VINAUDIT_KEY,
      format: 'json',
      pose: String(req.query.pose || 'front_right'),
      size: String(req.query.size || 'medium'),
      color: String(req.query.color || 'white'),
      // 'model' granularity lets all trims of a given year/make/model
      // share a single image (S5 Premium = S5 Premium Plus = S5 Prestige
      // visually) — saves per-call VinAudit cost.
      granularity: String(req.query.granularity || 'model'),
    });
    try {
      const r = await fetch(`https://images.vinaudit.com/v3/images?${params.toString()}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.success === false) {
        // VinAudit returns 400 for any VIN that isn't in their supported
        // YMMT spreadsheet (newer model years often aren't). That's
        // expected data-gap behavior, not an error worth screaming about
        // — downgrade to log so it doesn't fill the terminal with warnings.
        const isUnsupportedVinError =
          r.status === 400 &&
          Array.isArray(data?.error) &&
          data.error.some((m) => typeof m === 'string' && m.toLowerCase().includes('not supported'));
        if (isUnsupportedVinError) {
          console.log('[vinaudit-images←] VIN not in supported YMMT list (expected for new model years)');
        } else {
          console.warn('[vinaudit-images←]', r.status, data?.error);
        }
        return res.status(r.status >= 400 ? r.status : 502).json({
          error: data?.error || `VinAudit ${r.status}`,
        });
      }
      const images = Array.isArray(data?.images)
        ? data.images
            .filter((i) => i?.data && i?.content_type)
            .map((i) => ({ base64: i.data, mediaType: i.content_type, source: 'vinaudit' }))
        : [];
      res.json({ images, ymmt: data?.ymmt || null });
    } catch (err) {
      res.status(502).json({ error: String(err?.message || err) });
    }
  });

  // ── Vehicle listings (dev) ────────────────────────────────────────
  // Mirrors functions/api/listings.js. Kept deliberately close to the
  // Worker version — same normalization paths, same ZIP geocoding, same
  // error codes — so a listing that renders in dev renders in production.
  // The only differences are a plain in-process Map for the geocode cache
  // (no Cloudflare Cache API here) and CJS instead of ESM.
  const AUTODEV_URL = 'https://api.auto.dev/listings';
  const zipCache = new Map();

  const geocodeZipDev = async (zip) => {
    const clean = String(zip || '').trim().slice(0, 5);
    if (!/^\d{5}$/.test(clean)) return null;
    if (zipCache.has(clean)) return zipCache.get(clean);
    let resolved = null;
    try {
      const r = await fetch(`https://api.zippopotam.us/us/${clean}`);
      if (r.ok) {
        const d = await r.json();
        const p = Array.isArray(d?.places) ? d.places[0] : null;
        const lat = Number(p?.latitude);
        const lng = Number(p?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          resolved = { lat, lng, city: p['place name'] || null, state: p['state abbreviation'] || null };
        }
      }
    } catch { /* leave null — the card just won't get a pin */ }
    zipCache.set(clean, resolved);
    return resolved;
  };

  const toNum = (v) => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // `location` is [lng, lat] (GeoJSON order, not Leaflet's), is only populated
  // when the query is ZIP-scoped, and is [0, 0] otherwise. See the matching
  // comment in functions/api/listings.js.
  const readLoc = (raw) => {
    const loc = raw && raw.location;
    if (!Array.isArray(loc) || loc.length < 2) return { lat: null, lng: null };
    const lng = toNum(loc[0]);
    const lat = toNum(loc[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
    if (lat === 0 && lng === 0) return { lat: null, lng: null };
    return { lat, lng };
  };

  // `vdp` is sometimes a bare fragment ("#-5388555364916837171") rather than a
  // URL; as an <a href> that resolves against our own origin and reopens the
  // app. Mirrors safeListingUrl in functions/api/listings.js.
  const safeUrl = (v) => {
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return null;
    try {
      const u = new URL(v.trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
  };

  const normalizeDev = (raw) => {
    const vehicle = (raw && raw.vehicle) || {};
    const retail = (raw && (raw.retailListing || raw.wholesaleListing)) || {};
    const vin = (raw && raw.vin) || vehicle.vin;
    if (!vin) return null;

    const dealerName = typeof retail.dealer === 'string' ? retail.dealer : retail.dealer && retail.dealer.name;
    const n = String(dealerName || '').toLowerCase();
    const source = n.includes('carmax') ? 'carmax'
      : n.includes('carvana') ? 'carvana'
      : n.includes('private') ? 'private'
      : 'dealer';
    const { lat, lng } = readLoc(raw);

    return {
      vin: String(vin).toUpperCase(),
      year: toNum(vehicle.year),
      make: vehicle.make || null,
      model: vehicle.model || null,
      trim: vehicle.trim || vehicle.series || null,
      price: toNum(retail.price),
      mileage: toNum(retail.miles),
      exteriorColor: vehicle.exteriorColor || null,
      condition: retail.used === false ? 'new' : 'used',
      cpo: Boolean(retail.cpo),
      photos: retail.primaryImage ? [retail.primaryImage] : [],
      dealer: { name: dealerName || 'Dealer', source, city: null, state: null, lat, lng },
      listingUrl: safeUrl(retail.vdp),
      carfaxUrl: retail.carfaxUrl || null,
    };
  };

  app.get('/api/listings', async (req, res) => {
    if (!AUTODEV_KEY) {
      return res.status(503).json({
        error: 'listings_not_configured',
        message:
          'Vehicle listings need an Auto.dev API key. Create one free at https://auto.dev ' +
          '(1,000 calls/month) and add AUTODEV_API_KEY to .env, then restart npm start.',
      });
    }

    const authHeaders = { Authorization: `Bearer ${AUTODEV_KEY}`, 'Content-Type': 'application/json' };

    // Exact-VIN lookup uses the single-listing endpoint.
    const vinQuery = String(req.query.vin || '').toUpperCase();
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinQuery)) {
      try {
        const r = await fetch(`${AUTODEV_URL}/${encodeURIComponent(vinQuery)}`, { headers: authHeaders });
        if (r.status === 404) {
          return res.json({ listings: [], origin: null, page: 1, total: 0, hasMore: false });
        }
        if (!r.ok) {
          return res.status(502).json({ error: 'listings_upstream_error', message: `Auto.dev returned ${r.status}.` });
        }
        const b = await r.json().catch(() => null);
        const one = normalizeDev(b?.data || b);
        const listings = one ? [one] : [];
        return res.json({ listings, origin: null, page: 1, total: listings.length, hasMore: false });
      } catch (err) {
        return res.status(502).json({ error: 'listings_upstream_unreachable', message: String(err?.message || err) });
      }
    }

    const p = new URLSearchParams();
    p.set('limit', '20');
    p.set('includes', 'total'); // match count is opt-in
    const page = Math.max(1, Number(req.query.page) || 1);
    p.set('page', String(page));

    const zip = String(req.query.zip || '').trim();
    if (/^\d{5}$/.test(zip)) {
      p.set('zip', zip);
      const distance = Number(req.query.distance);
      if (Number.isFinite(distance) && distance > 0) p.set('distance', String(distance));
    }
    if (req.query.make) p.set('vehicle.make', String(req.query.make));
    if (req.query.model) p.set('vehicle.model', String(req.query.model));

    const SORTABLE = new Set(['createdAt', 'updatedAt', 'price', 'miles', 'year']);
    if (req.query.sort) {
      const [field, dir] = String(req.query.sort).split('.');
      if (SORTABLE.has(field) && (dir === 'asc' || dir === 'desc')) p.set('sort', String(req.query.sort));
    }
    if (req.query.cpo === 'true') p.set('retailListing.cpo', 'true');
    const BODY_STYLES = new Set(['Car', 'SUV', 'Truck', 'Van']);
    if (req.query.bodyStyle && BODY_STYLES.has(String(req.query.bodyStyle))) {
      p.set('vehicle.bodyStyle', String(req.query.bodyStyle));
    }

    const yearMin = Number(req.query.yearMin);
    const yearMax = Number(req.query.yearMax);
    if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && yearMin > 1900) {
      p.set('vehicle.year', `${Math.round(yearMin)}-${Math.round(yearMax)}`);
    }

    const priceMax = Number(req.query.priceMax);
    const priceMin = Number(req.query.priceMin);
    if (Number.isFinite(priceMax) && priceMax > 0) {
      p.set('retailListing.price', `${Number.isFinite(priceMin) && priceMin > 0 ? Math.round(priceMin) : 0}-${Math.round(priceMax)}`);
    }

    try {
      const r = await fetch(`${AUTODEV_URL}?${p.toString()}`, { headers: authHeaders });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        const message = r.status === 401 || r.status === 403
          ? 'Auto.dev rejected the API key. Check AUTODEV_API_KEY, or whether the monthly free quota is used up.'
          : `Auto.dev returned ${r.status}. ${detail.slice(0, 300)}`;
        console.warn('[listings←]', r.status, detail.slice(0, 300));
        return res.status(502).json({ error: 'listings_upstream_error', status: r.status, message });
      }
      const payload = await r.json().catch(() => null);
      const rows = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.records) ? payload.records
        : Array.isArray(payload) ? payload : [];
      const listings = rows.map(normalizeDev).filter(Boolean);
      const origin = /^\d{5}$/.test(zip) ? await geocodeZipDev(zip) : null;
      const total = Number(payload?.total);
      res.json({
        listings,
        origin,
        page,
        pageSize: 20,
        total: Number.isFinite(total) ? total : null,
        hasMore: Boolean(payload?.links?.next) || listings.length === 20,
      });
    } catch (err) {
      res.status(502).json({ error: 'listings_upstream_unreachable', message: String(err?.message || err) });
    }
  });

  // VinAudit — server injects key into query string
  app.use(
    '/api/vinaudit',
    createProxyMiddleware({
      target: 'https://marketvalue.vinaudit.com',
      changeOrigin: true,
      pathRewrite: (path) => {
        const url = new URL(path, 'http://x');
        const vin = url.searchParams.get('vin') || '';
        const key = VINAUDIT_KEY || '';
        return `/getmarketvalue.php?key=${encodeURIComponent(key)}&vin=${encodeURIComponent(vin)}&format=json`;
      },
      onProxyReq: stripBrowserHeaders,
    })
  );
};
