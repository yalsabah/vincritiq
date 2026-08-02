// Cloudflare Pages Function — catch-all Tripo3D proxy (API v3).
//
// Maps /api/tripo/<rest> → https://openapi.tripo3d.ai/v3/<rest>.
// Holds TRIPO_KEY server-side; client never sees the bearer token.
//
// Migrated from v2 (Aug 2026). Tripo is retiring the v2 API:
//   - 2026-10-01: v2 frozen (no updates/support)
//   - 2026-11-01: v2 endpoints stop accepting requests
// v3 changes the host (api.tripo3d.ai → openapi.tripo3d.ai) and the path
// prefix (/v2/openapi/ → /v3/). The API KEY is unchanged across versions.
// Docs: https://developers.tripo3d.ai/en/docs/migration-v2-to-v3
//
// The proxy stays a dumb pass-through — the v3 endpoint sub-paths and request
// bodies are constructed by the client (src/utils/model3d.js), so a future
// endpoint tweak is a one-file change there, not here.
const TRIPO_V3_BASE = 'https://openapi.tripo3d.ai/v3';

export async function onRequest({ request, env, params }) {
  if (!env.TRIPO_KEY) {
    return new Response(JSON.stringify({ error: 'TRIPO_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const subPath = (params.path || []).join('/');
  const upstreamUrl = `${TRIPO_V3_BASE}/${subPath}`;

  const headers = { Authorization: `Bearer ${env.TRIPO_KEY}` };
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const upstream = await fetch(upstreamUrl, init);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}
