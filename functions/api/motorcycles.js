// Cloudflare Pages Function — real motorcycle listings.
//
// Backed by MarketCheck's Motorcycles API (~300k active US dealer listings).
// Wired as a separate endpoint from /api/listings so cars and bikes stay in
// their own providers with their own quotas — a "Motorcycles" toggle in the
// Find surface routes here instead of Auto.dev.
//
//   Docs: https://docs.marketcheck.com/docs/api/motorcycles
//   Key:  https://marketcheck.com  →  developer dashboard  →  API key
//   Set as MARKETCHECK_API_KEY (Cloudflare Pages secret or local .env).
//
// The response is normalized to the SAME `Listing` shape /api/listings emits,
// so the existing card/map/agent stack renders it without any type branching.
// The two providers differ in useful ways though:
//   - MarketCheck lists build.make/model/trim and a real lat/lng+city+state per
//     listing (not just when a zip is present), so nationwide searches DO
//     populate the map. Photos are a real gallery, not one guessed URL.
//   - There is no VIN on many bike listings, so the record id is used as the
//     stable key. `id` is the field; VIN is null when absent.

const MC_URL = 'https://api.marketcheck.com/v2/search/motorcycle/active';
const MC_FACETS_URL = 'https://api.marketcheck.com/v2/search/motorcycle/active';

// MarketCheck's free tier is 500 calls/mo and 5 req/sec; a modest page size
// keeps a single load-more click from blowing that budget.
const PAGE_SIZE = 20;

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ─── Normalization ────────────────────────────────────────────────────────────

// Price parser — strips currency/commas ("$28,995" → 28995). Won't preserve a
// minus sign, so it must NOT be used for coordinates: MarketCheck sends lng as
// "-94.52221" and stripping the '-' plants MO in western China.
const toNumber = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Coordinate parser — preserves the sign. Native Number() handles the string
// "-94.52221" correctly, and there's no thousands separator to strip.
const toCoord = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Filter photo URLs the CDN sometimes returns as multiple sizes of the same
// asset; keep the biggest per image so the card gets a sharp thumbnail rather
// than a 300×225 blur when a larger version exists in the list.
function pickBestPhotos(urls) {
  if (!Array.isArray(urls)) return [];
  return urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 8);
}

// vdp_url can be dealer-internal, sometimes a fragment; treat anything that
// isn't a real absolute http(s) URL as missing (same guard as the car proxy).
function safeUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

function normalize(raw) {
  const build = raw?.build || {};
  const dealer = raw?.dealer || {};
  // Stable per-listing id used as the card key. Prefer VIN when present so a
  // saved listing keeps its identity across sessions; fall back to MarketCheck's
  // own id (unique but rotates when a listing is re-scraped).
  const id = (raw?.vin || raw?.id || '').toString();
  if (!id) return null;

  return {
    // The UI treats VIN as the row key. Cars always have one; bike listings
    // sometimes don't, so we synthesize a stable identifier — the shape is the
    // same VIN-looking uppercase string so no downstream code needs branching.
    vin: id.toUpperCase(),
    year: toNumber(build.year),
    make: build.make || null,
    model: build.model || null,
    trim: build.trim || null,
    price: toNumber(raw?.price),
    mileage: toNumber(raw?.miles),
    exteriorColor: raw?.color || null,
    condition: raw?.inventory_type === 'new' ? 'new' : 'used',
    cpo: Boolean(raw?.cpo || raw?.certified),
    photos: pickBestPhotos(raw?.media?.photo_links),
    primaryImage: raw?.media?.photo_links?.[0] || null,
    photoCount: Array.isArray(raw?.media?.photo_links) ? raw.media.photo_links.length : 0,
    dealer: {
      name: dealer.name || 'Dealer',
      // No brand-level source distinction here — MarketCheck is dealer-only, no
      // CarMax/Carvana equivalents in bikes. 'dealer' matches the card's default
      // badge palette.
      source: 'dealer',
      city: dealer.city || null,
      state: dealer.state || null,
      lat: toCoord(dealer.latitude),
      lng: toCoord(dealer.longitude),
    },
    listingUrl: safeUrl(raw?.vdp_url),
    // MarketCheck has no CARFAX pass-through for bikes.
    carfaxUrl: null,
    // Provider tag lets the panel show a subtle "MarketCheck" attribution and
    // distinguishes rows in a mixed cache from the Auto.dev ones.
    provider: 'marketcheck',
  };
}

// ─── Query building ───────────────────────────────────────────────────────────

// Map the client's normalized params (same names the cars endpoint uses)
// onto MarketCheck's own vocabulary. Anything unset is omitted so it doesn't
// contribute to the quota check.
function buildQuery(params, key) {
  const q = new URLSearchParams();
  q.set('api_key', key);
  q.set('rows', String(PAGE_SIZE));

  const page = Math.max(1, Number(params.get('page')) || 1);
  q.set('start', String((page - 1) * PAGE_SIZE));

  const make = params.get('make');
  if (make) q.set('make', make);
  const model = params.get('model');
  if (model) q.set('model', model);
  // MarketCheck splits a full model name like "CRF300L" into model="Crf" +
  // trim="300l Abs" — searching model=CRF300L alone matches nothing (verified
  // live). The client already retries with the remainder as `trim` when a
  // model-only search comes back empty (same fallback used for cars); this
  // just has to accept the param.
  const trim = params.get('trim');
  if (trim) q.set('trim', trim);
  const condition = params.get('condition');
  if (condition === 'new' || condition === 'used') q.set('inventory_type', condition);

  const yearMin = Number(params.get('yearMin'));
  const yearMax = Number(params.get('yearMax'));
  if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && yearMin > 1900) {
    q.set('year', `${yearMin}-${yearMax}`);
  }

  const priceMin = Number(params.get('priceMin'));
  const priceMax = Number(params.get('priceMax'));
  const sortRaw = params.get('sort') || '';
  const priceSortAsc = sortRaw === 'price.asc';
  if (Number.isFinite(priceMax) && priceMax > 0) {
    // Explicit range from the user — floor at $100 (or their min) so null-price
    // rows are excluded either way. MarketCheck matches null against a range,
    // which puts $0 dealer placeholders at the top of a price-asc sort.
    const lo = Number.isFinite(priceMin) && priceMin > 0 ? Math.round(priceMin) : 100;
    q.set('price_range', `${lo}-${Math.round(priceMax)}`);
  } else if (priceSortAsc) {
    // Cheapest-first with no explicit range — still needs the floor for the
    // same reason. Upper bound is deliberately huge; the sort caps the page.
    q.set('price_range', '100-99999999');
  }

  const milesMax = Number(params.get('milesMax'));
  const milesMin = Number(params.get('milesMin'));
  if (Number.isFinite(milesMax) && milesMax > 0) {
    q.set('miles_range', `${Number.isFinite(milesMin) && milesMin > 0 ? Math.round(milesMin) : 0}-${Math.round(milesMax)}`);
  }

  const zip = params.get('zip');
  if (zip && /^\d{5}$/.test(zip)) {
    q.set('zip', zip);
    // 'nationwide' arrives as a non-numeric string; leaving `radius` off lets
    // MarketCheck apply its own default, which is generous.
    const dist = Number(params.get('distance'));
    if (Number.isFinite(dist) && dist > 0) q.set('radius', String(dist));
  }

  // Sort. `sort_by=price&sort_order=asc` is the shape MarketCheck expects;
  // 'updatedAt.desc' from the client maps to the freshness signal.
  const sort = params.get('sort') || '';
  if (sort === 'price.asc') { q.set('sort_by', 'price'); q.set('sort_order', 'asc'); }
  else if (sort === 'price.desc') { q.set('sort_by', 'price'); q.set('sort_order', 'desc'); }
  else if (sort === 'miles.asc') { q.set('sort_by', 'miles'); q.set('sort_order', 'asc'); }
  else if (sort === 'year.desc') { q.set('sort_by', 'year'); q.set('sort_order', 'desc'); }
  else { q.set('sort_by', 'last_seen_at'); q.set('sort_order', 'desc'); }

  return q;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  const key = env.MARKETCHECK_API_KEY;
  if (!key) {
    return json({
      error: 'motorcycles_not_configured',
      message:
        'Motorcycle listings need a MarketCheck API key. Create one free at ' +
        'https://marketcheck.com and add it as the MARKETCHECK_API_KEY secret.',
    }, 503);
  }

  const params = new URL(request.url).searchParams;
  // Facet endpoint — used by the sidebar's Model dropdown, same contract as
  // /api/vehicle-models. Kept on this endpoint so the motorcycles provider is
  // one file, not two.
  const facetMake = params.get('modelsForMake');
  if (facetMake) {
    const q = new URLSearchParams({ api_key: key, rows: '0', facets: 'model', make: facetMake });
    try {
      const r = await fetch(`${MC_FACETS_URL}?${q}`);
      if (!r.ok) return json({ models: [] }, 502);
      const body = await r.json().catch(() => null);
      const facet = body?.facets?.model || [];
      const models = facet.map((m) => (m?.item || '').trim()).filter(Boolean).slice(0, 60);
      return json({ make: facetMake, models });
    } catch (err) {
      return json({ models: [], error: String(err?.message || err) }, 502);
    }
  }

  const upstream = `${MC_URL}?${buildQuery(params, key)}`;
  let res;
  try {
    res = await fetch(upstream);
  } catch (err) {
    return json({ error: 'upstream_unreachable', message: String(err?.message || err) }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message =
      res.status === 401 || res.status === 403
        ? 'MarketCheck rejected the API key. Check MARKETCHECK_API_KEY and whether the free quota is used up.'
        : `MarketCheck returned ${res.status}. ${detail.slice(0, 200)}`;
    return json({ error: 'upstream_error', status: res.status, message }, 502);
  }

  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body?.listings) ? body.listings : [];
  const listings = rows.map(normalize).filter(Boolean);
  const total = Number(body?.num_found);

  return json({
    listings,
    origin: null,
    page: Math.max(1, Number(params.get('page')) || 1),
    pageSize: PAGE_SIZE,
    total: Number.isFinite(total) ? total : null,
    // MarketCheck doesn't return a "next" flag; a full page implies more.
    hasMore: listings.length === PAGE_SIZE,
    provider: 'marketcheck',
  });
}
