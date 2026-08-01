// Cloudflare Pages Function — proxies Anthropic Messages API.
// Holds CLAUDE_API_KEY server-side so it's never shipped to the browser.
// Streams responses through unchanged so client-side SSE parsing continues to work.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function passthrough(upstream) {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      // Without this, some CDN/proxy layers buffer the whole SSE response and
      // the client sees the report appear all at once at the end instead of
      // streaming in.
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.CLAUDE_API_KEY) {
    return jsonError('CLAUDE_API_KEY not configured', 500);
  }

  // The body is buffered rather than streamed straight through because we may
  // need to replay it (see the beta-rejection retry below). Vehicle photos are
  // compressed client-side before they're base64'd, so this stays well inside
  // a Worker's memory budget.
  const body = await request.arrayBuffer();

  // Beta features travel from the client as `x-anthropic-beta` so the request
  // that needs a beta is the one that carries it — the Worker doesn't have to
  // know which features the client is using.
  const betas = request.headers.get('x-anthropic-beta') || '';

  const send = (betaHeader) =>
    fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(betaHeader ? { 'anthropic-beta': betaHeader } : {}),
      },
      body,
    });

  let upstream = await send(betas);

  // If a beta we opted into isn't available on this account, retry once
  // without it rather than failing the user's analysis outright. Refusal
  // fallbacks are a nice-to-have; a working response is not.
  if (!upstream.ok && betas && upstream.status === 400) {
    const detail = await upstream.clone().text().catch(() => '');
    if (/beta|fallback/i.test(detail)) {
      upstream = await send('');
    }
  }

  // Non-2xx bodies are JSON, not SSE. Forwarding them with the SSE
  // content-type made the client's `response.json()` error path throw on the
  // parse instead of surfacing Anthropic's actual message.
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return new Response(detail || JSON.stringify({ error: { message: upstream.statusText } }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return passthrough(upstream);
}
