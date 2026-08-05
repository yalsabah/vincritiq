// Cloudflare Pages Function — model names for a given make.
//
// Backs the sidebar Make → Model dropdown. Uses Auto.dev's listing FACETS
// (?includes=facets&vehicle.make=X), which return the models that actually
// have inventory for that make, ranked by volume — and, crucially, spelled
// exactly the way the vehicle.model filter expects. A generic VIN dataset
// (NHTSA etc.) would list models Auto.dev names differently, producing empty
// searches; the facets can't drift from the filter.

const AUTODEV_URL = 'https://api.auto.dev/listings';
// Facet groups are large; cap what we hand the dropdown.
const MAX_MODELS = 60;

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
  });

export async function onRequestGet({ request, env }) {
  if (!env.AUTODEV_API_KEY) return json({ error: 'listings_not_configured', models: [] }, 503);

  const make = (new URL(request.url).searchParams.get('make') || '').trim();
  if (!make) return json({ models: [] }, 400);

  const upstream = `${AUTODEV_URL}?limit=1&includes=facets&vehicle.make=${encodeURIComponent(make)}`;
  let res;
  try {
    res = await fetch(upstream, {
      headers: { Authorization: `Bearer ${env.AUTODEV_API_KEY}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return json({ error: 'upstream_unreachable', models: [] }, 502);
  }
  if (!res.ok) return json({ error: `upstream_${res.status}`, models: [] }, 502);

  const body = await res.json().catch(() => null);
  const modelsFacet = body?.facets?.models || {};
  // Facet keys look like "S5 (1234)" — strip the count, keep the model name,
  // and preserve the API's volume ordering (Object insertion order).
  const models = Object.keys(modelsFacet)
    .map((k) => k.replace(/\s*\(\d[\d,]*\)\s*$/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_MODELS);

  return json({ make, models });
}
