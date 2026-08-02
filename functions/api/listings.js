// Cloudflare Pages Function — real used-vehicle listings for "Find Me a Car".
//
// Backed by the Auto.dev Vehicle Listings API, which aggregates live inventory
// from US physical + online dealers. Chosen over Marketcheck / VehicleDatabases
// because its Starter tier is $0/month with 1,000 free calls (then $0.002 per
// listings call) while still returning real inventory rather than a sample set.
//
//   Docs: https://docs.auto.dev/v2/products/vehicle-listings
//   Key:  https://auto.dev  →  dashboard  →  API key
//   Set as the AUTODEV_API_KEY secret in the Cloudflare Pages dashboard.
//
// Two jobs beyond proxying:
//
//   1. Normalization. Auto.dev returns `{ vehicle, retailListing, location }`
//      with the interesting fields split across the first two and coordinates
//      in a bare GeoJSON-ordered array. We flatten that to the `Listing` shape
//      the UI renders. The mapping is pinned to the observed response, not
//      guessed — see normalizeListing.
//
//   2. Map origin. Listing coordinates come straight from the feed (and only
//      when the query is ZIP-scoped — see readLocation). The search ZIP itself
//      is geocoded through Zippopotam.us (free, key-less) and cached in the
//      Cloudflare edge cache so the map can centre on the user's area.
//
// There is deliberately no fallback to sample data. If the key is missing or
// upstream fails, this returns an error the UI renders as an error — showing
// invented inventory to someone shopping for a car would be worse than showing
// nothing.

const AUTODEV_URL = 'https://api.auto.dev/listings';
const ZIPPOPOTAM_URL = 'https://api.zippopotam.us/us/';

// Auto.dev's Starter plan caps `limit` at 20. Asking for more is a 400, so the
// page size is pinned here rather than taken from the client.
const PAGE_SIZE = 20;

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ─── Geocoding ────────────────────────────────────────────────────────────────

// ZIP → { lat, lng, city, state }, or null. Results are stored in the edge
// cache under a synthetic key for 30 days — ZIP centroids don't move, and this
// keeps a busy search page from hammering a free public endpoint.
async function geocodeZip(zip, memo) {
  const clean = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(clean)) return null;
  if (memo.has(clean)) return memo.get(clean);

  const cacheKey = new Request(`https://geocode.internal/zip/${clean}`);
  const cache = caches.default;

  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      memo.set(clean, cached);
      return cached;
    }
  } catch {
    // Cache API unavailable (e.g. local `wrangler dev`) — fall through to a
    // live lookup rather than failing the whole request.
  }

  let resolved = null;
  try {
    const res = await fetch(`${ZIPPOPOTAM_URL}${clean}`);
    if (res.ok) {
      const data = await res.json();
      const place = Array.isArray(data?.places) ? data.places[0] : null;
      if (place) {
        const lat = Number(place.latitude);
        const lng = Number(place.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          resolved = {
            lat,
            lng,
            city: place['place name'] || null,
            state: place['state abbreviation'] || null,
          };
        }
      }
    }
  } catch {
    resolved = null;
  }

  memo.set(clean, resolved);
  if (resolved) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(resolved), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' },
        }),
      );
    } catch {
      // Non-fatal: we already have the answer for this request.
    }
  }
  return resolved;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function toNumber(value) {
  if (value == null) return null;
  // Prices arrive as both numbers and strings like "$28,995".
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Map a dealer/seller name onto the badge vocabulary the cards already use.
// `retailListing.dealer` is a plain string ("Carvana", "CarMax", a franchise
// name), so this is the only signal available for the badge.
function classifySource(dealerName) {
  const name = String(dealerName || '').toLowerCase();
  if (name.includes('carmax')) return 'carmax';
  if (name.includes('carvana')) return 'carvana';
  if (name.includes('private')) return 'private';
  return 'dealer';
}

// Coordinates arrive as a bare `location: [lng, lat]` pair — GeoJSON order, NOT
// the [lat, lng] Leaflet expects. Getting this backwards puts every US car in
// the Indian Ocean.
//
// Two further quirks, both load-bearing:
//   - `location` is only populated when the query includes a `zip`. A
//     nationwide search returns [0, 0] for every row.
//   - [0, 0] is Null Island, not a real place, so it has to be rejected
//     rather than plotted.
function readLocation(raw) {
  const loc = raw?.location;
  if (!Array.isArray(loc) || loc.length < 2) return { lat: null, lng: null };
  const lng = toNumber(loc[0]);
  const lat = toNumber(loc[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
  if (lat === 0 && lng === 0) return { lat: null, lng: null };
  return { lat, lng };
}

// `retailListing.vdp` is not reliably a URL. Alongside real links it carries
// bare fragments like "#-5388555364916837171" for dealers that don't expose a
// public detail page. Rendered as an <a href> those resolve against our OWN
// origin, so "Open original listing" opened a second copy of the app instead of
// the dealer's page. Anything that isn't an absolute http(s) URL is dropped so
// the link simply doesn't render.
function safeListingUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    // Reject anything malformed enough that the browser would treat it as relative.
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function normalizeListing(raw) {
  const vehicle = raw?.vehicle || {};
  const retail = raw?.retailListing || raw?.wholesaleListing || {};

  const vin = raw?.vin || vehicle.vin;
  if (!vin) return null; // The UI keys everything off VIN; a listing without one is unusable.

  const dealerName = typeof retail.dealer === 'string' ? retail.dealer : retail.dealer?.name;
  const { lat, lng } = readLocation(raw);

  return {
    vin: String(vin).toUpperCase(),
    year: toNumber(vehicle.year),
    make: vehicle.make || null,
    model: vehicle.model || null,
    // `trim` is the short label ("T5 Momentum"); `series` is the long-form
    // description ("T5 Momentum 4dr Sedan (2.0L 4cyl Turbo 8A)"). Prefer the
    // short one for the card and fall back to the verbose one.
    trim: vehicle.trim || vehicle.series || null,
    price: toNumber(retail.price),
    mileage: toNumber(retail.miles),
    exteriorColor: vehicle.exteriorColor || null,
    condition: retail.used === false ? 'new' : 'used',
    cpo: Boolean(retail.cpo),
    // Only ONE photo URL is ever exposed, even when photoCount says there are
    // six — the feed gives `primaryImage` and a count, not a gallery. Both are
    // surfaced: `photos` for rendering, `photoCount` so callers can tell
    // "no photos" from "more exist that we can't reach".
    photos: retail.primaryImage ? [retail.primaryImage] : [],
    primaryImage: retail.primaryImage || null,
    photoCount: toNumber(retail.photoCount) || 0,
    dealer: {
      name: dealerName || 'Dealer',
      source: classifySource(dealerName),
      // The feed carries no city/state/ZIP for a listing — only coordinates,
      // and only when the search was ZIP-scoped. The card falls back to the
      // dealer name rather than rendering an empty ", " placeholder.
      city: null,
      state: null,
      lat,
      lng,
    },
    listingUrl: safeListingUrl(retail.vdp),
    // Deep link to this VIN's CARFAX. The Buy-mode analyzer already knows how
    // to use vehicle history, so carrying it through the funnel is free value.
    carfaxUrl: retail.carfaxUrl || null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  const KEY = env.AUTODEV_API_KEY;
  if (!KEY) {
    // A distinct code so the UI can render setup instructions instead of a
    // generic failure — this is a configuration gap, not an outage.
    return json(
      {
        error: 'listings_not_configured',
        message:
          'Vehicle listings need an Auto.dev API key. Create one free at https://auto.dev ' +
          '(1,000 calls/month) and add it as the AUTODEV_API_KEY secret in Cloudflare Pages.',
      },
      503,
    );
  }

  const params = new URL(request.url).searchParams;
  const memo = new Map();

  // Exact-VIN lookup uses a different endpoint that returns a single record
  // rather than a paged envelope, so it short-circuits the filter builder.
  const vinQuery = (params.get('vin') || '').trim().toUpperCase();
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinQuery)) {
    let vinRes;
    try {
      vinRes = await fetch(`${AUTODEV_URL}/${encodeURIComponent(vinQuery)}`, {
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return json({ error: 'listings_upstream_unreachable', message: String(err?.message || err) }, 502);
    }

    // A VIN with no active listing is an empty result, not an error — the
    // panel renders "no matches", same as any other unproductive search.
    if (vinRes.status === 404) {
      return json({ listings: [], origin: null, page: 1, pageSize: PAGE_SIZE, total: 0, hasMore: false });
    }
    if (!vinRes.ok) {
      return json({ error: 'listings_upstream_error', status: vinRes.status, message: `Auto.dev returned ${vinRes.status}.` }, 502);
    }

    const vinBody = await vinRes.json().catch(() => null);
    const record = vinBody?.data || vinBody;
    const one = record ? normalizeListing(record) : null;
    const listings = one ? [one] : [];
    return json({ listings, origin: null, page: 1, pageSize: PAGE_SIZE, total: listings.length, hasMore: false });
  }

  const upstreamParams = new URLSearchParams();
  upstreamParams.set('limit', String(PAGE_SIZE));
  // The match count is opt-in — without this the envelope carries no total at
  // all and the sidebar can only report "N listings" for the current page.
  upstreamParams.set('includes', 'total');

  const page = Math.max(1, Number(params.get('page')) || 1);
  upstreamParams.set('page', String(page));

  const zip = (params.get('zip') || '').trim();
  if (/^\d{5}$/.test(zip)) {
    upstreamParams.set('zip', zip);
    const distance = Number(params.get('distance'));
    // 'nationwide' arrives as a non-numeric value; omitting `distance`
    // lets Auto.dev apply its own default rather than us inventing one.
    if (Number.isFinite(distance) && distance > 0) {
      upstreamParams.set('distance', String(distance));
    }
  }

  // Free-text is split by the client into make/model(/trim), because Auto.dev
  // filters on structured fields rather than a single query string.
  //
  // `vehicle.model` and `vehicle.trim` are EXACT-match fields upstream —
  // `vehicle.model=camr` returns 0 rows even though `vehicle.model=camry`
  // returns 45,784. That's fatal for a live-as-you-type search box, since
  // every keystroke before the model name is fully typed would show "no
  // results". Auto.dev does support a trailing `*` as a prefix wildcard
  // (`vehicle.model=camr*` matches Camry), confirmed against the live API,
  // so a wildcard is appended to whatever the client sent unless it's
  // already there.
  const wildcard = (s) => (s.endsWith('*') ? s : `${s}*`);

  const make = (params.get('make') || '').trim();
  const model = (params.get('model') || '').trim();
  const trim = (params.get('trim') || '').trim();
  if (make) upstreamParams.set('vehicle.make', make);
  if (model) upstreamParams.set('vehicle.model', wildcard(model));
  // `trim` is a distinct upstream field from `model` — e.g. a BMW "M340i" is
  // vehicle.model="3 Series" + vehicle.trim="M340i". The client sends this
  // as a fallback when a model-shaped search comes back empty (see
  // fetchListings in src/utils/listings.js), so a token like "m340i" that
  // isn't a model name at all still resolves.
  if (trim) upstreamParams.set('vehicle.trim', wildcard(trim));

  // Auto.dev expresses numeric filters as `min-max` range strings.
  const priceMin = Number(params.get('priceMin'));
  const priceMax = Number(params.get('priceMax'));
  if (Number.isFinite(priceMax) && priceMax > 0) {
    upstreamParams.set(
      'retailListing.price',
      `${Number.isFinite(priceMin) && priceMin > 0 ? Math.round(priceMin) : 0}-${Math.round(priceMax)}`,
    );
  }

  const yearMin = Number(params.get('yearMin'));
  const yearMax = Number(params.get('yearMax'));
  if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && yearMin > 1900) {
    upstreamParams.set('vehicle.year', `${Math.round(yearMin)}-${Math.round(yearMax)}`);
  }

  // Allow-listed rather than pattern-matched: Auto.dev rejects an unknown sort
  // field outright, so a typo in the client would break the whole search.
  const SORTABLE = new Set(['createdAt', 'updatedAt', 'price', 'miles', 'year']);
  const sort = params.get('sort');
  if (sort) {
    const [field, dir] = sort.split('.');
    if (SORTABLE.has(field) && (dir === 'asc' || dir === 'desc')) {
      upstreamParams.set('sort', sort);
    }
  }

  if (params.get('cpo') === 'true') upstreamParams.set('retailListing.cpo', 'true');

  // Allow-listed so a bogus value can't be smuggled into the upstream query.
  const BODY_STYLES = new Set(['Car', 'SUV', 'Truck', 'Van']);
  const bodyStyle = params.get('bodyStyle');
  if (bodyStyle && BODY_STYLES.has(bodyStyle)) upstreamParams.set('vehicle.bodyStyle', bodyStyle);

  let upstream;
  try {
    upstream = await fetch(`${AUTODEV_URL}?${upstreamParams.toString()}`, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    return json({ error: 'listings_upstream_unreachable', message: String(err?.message || err) }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    // 401/403 almost always means a bad or exhausted key; say so plainly
    // rather than leaving the user to guess from a raw status code.
    const message =
      upstream.status === 401 || upstream.status === 403
        ? 'Auto.dev rejected the API key. Check AUTODEV_API_KEY, or whether the monthly free quota is used up.'
        : `Auto.dev returned ${upstream.status}. ${detail.slice(0, 300)}`;
    return json({ error: 'listings_upstream_error', status: upstream.status, message }, 502);
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload) {
    return json({ error: 'listings_bad_response', message: 'Auto.dev returned a non-JSON body.' }, 502);
  }

  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.records)
      ? payload.records
      : Array.isArray(payload)
        ? payload
        : [];

  const listings = rows.map(normalizeListing).filter(Boolean);

  // The map needs somewhere to centre. When the user supplied a ZIP we hand
  // back its centroid so the view frames their search area rather than the
  // whole country.
  const origin = /^\d{5}$/.test(zip) ? await geocodeZip(zip, memo) : null;

  const total = Number(payload?.total);

  return json({
    listings,
    origin,
    page,
    pageSize: PAGE_SIZE,
    total: Number.isFinite(total) ? total : null,
    // `links.next` is Auto.dev's own signal that more pages exist; falling
    // back to a full page is the right guess when it's absent.
    hasMore: Boolean(payload?.links?.next) || listings.length === PAGE_SIZE,
  });
}
