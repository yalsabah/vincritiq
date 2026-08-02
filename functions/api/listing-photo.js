// Cloudflare Pages Function — byte proxy for listing photos.
//
// Why this exists: the photo host answers with
//   access-control-allow-origin: https://ui.auto.dev
// so it renders fine in an <img> (images aren't CORS-gated for display) but a
// browser `fetch()` from our origin is blocked. The Analyze funnel needs the
// actual bytes — vehicleImages are compressed and base64'd before they go to
// Claude — so the fetch has to happen server-side, where CORS doesn't apply.
//
// The host is allowlisted rather than proxying arbitrary URLs: an open
// URL-fetcher is an SSRF hole, and lets anyone use the deployment as a free
// bandwidth relay.

const ALLOWED_HOSTS = new Set([
  'retail.photos.vin',
  'photos.vin',
]);

// Generous enough for a dealer hero shot, small enough that a malicious URL
// can't stream gigabytes through the worker.
const MAX_BYTES = 8 * 1024 * 1024;

const fail = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequestGet({ request }) {
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) return fail(400, 'url parameter required');

  let target;
  try {
    target = new URL(raw);
  } catch {
    return fail(400, 'malformed url');
  }

  if (target.protocol !== 'https:') return fail(400, 'https only');
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return fail(403, `host not allowed: ${target.hostname}`);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      // The origin header the host wants to see. Without it some CDNs 403.
      headers: { Accept: 'image/*' },
    });
  } catch (err) {
    return fail(502, `upstream unreachable: ${String(err?.message || err)}`);
  }

  // A VIN-derived photo URL that doesn't exist is the common case, not an
  // exception — the feed builds these URLs optimistically and a good share
  // 404. Pass the status through so the caller can treat it as "no photo"
  // rather than an error worth surfacing.
  if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, `upstream ${upstream.status}`);

  const type = upstream.headers.get('Content-Type') || '';
  if (!type.startsWith('image/')) return fail(415, `not an image: ${type}`);

  const length = Number(upstream.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_BYTES) return fail(413, 'image too large');

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': type,
      // Same bytes for everyone; let the edge keep them for a day.
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
