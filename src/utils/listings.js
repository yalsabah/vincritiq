// Live vehicle-listings client for "Find Me a Car".
//
// Replaces the Phase 1 hand-curated fixture set. Everything rendered by
// FindACarPanel now comes from real dealer inventory via /api/listings (an
// Auto.dev proxy — see functions/api/listings.js). There is no sample-data
// fallback on purpose: if the feed is down or unconfigured, the panel says so
// rather than showing invented cars to someone actually shopping.
//
// Division of labour with the server:
//   - Server:  auth, the upstream query, normalization, ZIP → lat/lng.
//   - Client:  parsing the free-text box into structured filters, and the
//              refinements Auto.dev can't express (trim substring, mileage
//              ceiling, source badge). Those run over the returned page only,
//              which is why they're framed as refinements rather than search.

// Slider ceilings. Exported so the panel and the request builder agree on
// what "maxed out" means — they were previously duplicated literals, which is
// how an at-max slider ends up silently filtering out expensive cars.
export const PRICE_CEILING = 250000;
export const MILEAGE_CEILING = 200000;

// Year bounds, shared with the panel so both agree on what "unfiltered" means.
export const EARLIEST_YEAR = 1990;
export const LATEST_YEAR = new Date().getFullYear() + 1;

// Distance options for the radius filter. 'nationwide' is a sentinel
// (no radius cap). Each numeric value is miles.
export const DISTANCE_OPTIONS = [
  { id: 50, label: '50 miles' },
  { id: 100, label: '100 miles' },
  { id: 250, label: '250 miles' },
  { id: 'nationwide', label: 'Nationwide' },
];

// Source badges for the listing cards. Centralized so colors and
// labels stay consistent between cards, map pins, and filter pills.
export const SOURCE_LABELS = {
  carmax: { label: 'CarMax', color: '#1564ff' },
  carvana: { label: 'Carvana', color: '#3b82f6' },
  dealer: { label: 'Dealer', color: '#7c3aed' },
  private: { label: 'Private Seller', color: '#0f766e' },
};

// Great-circle distance in miles between two lat/lng points. Haversine.
export function distanceMiles(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const R = 3958.8; // Earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Error surfaced to the panel. `code` lets the UI distinguish "you haven't
// set this up yet" (actionable setup instructions) from "the feed broke"
// (retry), which read very differently to a user.
export class ListingsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ListingsError';
    this.code = code || 'listings_error';
  }
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

// Every make Auto.dev's `vehicle.make` filter recognizes, lowercased. This
// exists so a one-word search can be classified without a probe request:
// "toyota" is a make, "camry" is a model, and guessing wrong returns zero
// results rather than a near miss. Matching is case-insensitive upstream, and
// multi-word makes are hyphenated ("mercedes-benz").
const MAKES = new Set([
  'acura', 'alfa romeo', 'aston martin', 'audi', 'bentley', 'bmw', 'buick',
  'cadillac', 'chevrolet', 'chrysler', 'dodge', 'ferrari', 'fiat', 'ford',
  'genesis', 'gmc', 'honda', 'hummer', 'hyundai', 'infiniti', 'jaguar', 'jeep',
  'kia', 'lamborghini', 'land rover', 'lexus', 'lincoln', 'lotus', 'lucid',
  'maserati', 'mazda', 'mclaren', 'mercedes-benz', 'mercury', 'mini',
  'mitsubishi', 'nissan', 'oldsmobile', 'plymouth', 'polestar', 'pontiac',
  'porsche', 'ram', 'rivian', 'rolls-royce', 'saab', 'saturn', 'scion',
  'smart', 'subaru', 'suzuki', 'tesla', 'toyota', 'volkswagen', 'volvo',
]);

// What people actually type vs. what the API expects.
const MAKE_ALIASES = {
  chevy: 'chevrolet', vw: 'volkswagen', mercedes: 'mercedes-benz',
  benz: 'mercedes-benz', 'mercedes benz': 'mercedes-benz', beemer: 'bmw',
  bimmer: 'bmw', 'land-rover': 'land rover', landrover: 'land rover',
  'rolls royce': 'rolls-royce', 'alfa': 'alfa romeo', vette: 'chevrolet',
};

const canonicalMake = (s) => {
  const k = String(s || '').toLowerCase().trim();
  const aliased = MAKE_ALIASES[k] || k;
  return MAKES.has(aliased) ? aliased : null;
};

// Auto.dev filters on structured make/model, not a single query string, so the
// one search box has to be split before it's sent.
//
// The naive "first token is the make" split was wrong: searching "camry" sent
// `vehicle.make=camry`, which matches nothing, so the panel showed zero results
// for a car with 45,000 listings. Instead the leading token(s) are checked
// against the known-make list — two tokens first, so "mercedes benz c300" and
// "land rover defender" resolve correctly — and anything that isn't a make is
// treated as a model.
//
// Whatever is left over after make + model becomes trim detail. That split
// matters too: `vehicle.model` matches the bare model name, so sending
// "s5 sportback" as the model returns nothing. Trailing tokens are refined
// locally instead — "audi s5 sportback" queries Audi S5 upstream and narrows
// to Sportback here. A 17-character token is routed as a VIN.
export function parseQuery(raw) {
  const q = String(raw || '').trim();
  const empty = { make: '', model: '', trimTokens: [], vin: '' };
  if (!q) return empty;
  if (VIN_RE.test(q)) return { ...empty, vin: q.toUpperCase() };

  const parts = q.split(/\s+/);

  // Longest-match-first so two-word makes beat their first token.
  const twoWord = parts.length >= 2 ? canonicalMake(`${parts[0]} ${parts[1]}`) : null;
  const oneWord = canonicalMake(parts[0]);

  let make = '';
  let rest = parts;
  if (twoWord) {
    make = twoWord;
    rest = parts.slice(2);
  } else if (oneWord) {
    make = oneWord;
    rest = parts.slice(1);
  }

  return {
    make,
    model: rest[0] || '',
    trimTokens: rest.slice(1).map((t) => t.toLowerCase()),
    vin: '',
  };
}

/**
 * Fetch a page of live listings.
 *
 * @param {object} filters
 * @param {string}  [filters.q]          Free-text — split into make/model or detected as a VIN
 * @param {string}  [filters.zip]        5-digit US ZIP; required for radius search
 * @param {number|'nationwide'} [filters.radius]
 * @param {[number, number]} [filters.priceRange]
 * @param {number}  [filters.page]
 * @param {AbortSignal} [filters.signal] Cancels a superseded in-flight search
 * @returns {Promise<{ listings: Array, origin: object|null, page: number, total: number|null, hasMore: boolean }>}
 */
export async function fetchListings(filters = {}) {
  const { make, model, vin } = parseQuery(filters.q);

  const params = new URLSearchParams();
  if (vin) {
    // A VIN search is exact — every other filter is noise, so send it alone
    // and let the server hit Auto.dev's single-listing endpoint.
    params.set('vin', vin);
    return requestListings(params, filters.signal);
  }
  if (make) params.set('make', make);
  if (model) params.set('model', model);

  const zip = String(filters.zip || '').trim();
  if (/^\d{5}$/.test(zip)) {
    params.set('zip', zip);
    if (filters.radius && filters.radius !== 'nationwide') {
      params.set('distance', String(filters.radius));
    }
  }

  const [priceMin, priceMax] = filters.priceRange || [];
  // The panel's price slider tops out at its max value, which means "no
  // ceiling" rather than a literal cap — sending it would exclude anything
  // above it, so an at-max slider is treated as unset.
  if (Number.isFinite(priceMax) && priceMax > 0 && priceMax < PRICE_CEILING) {
    params.set('priceMin', String(priceMin || 0));
    params.set('priceMax', String(priceMax));
  }

  // Year is a genuine upstream range filter (`vehicle.year=2018-2024`), so it
  // narrows the query rather than the page. Only sent when it's actually
  // narrower than the full span — otherwise it's noise on every request.
  const [yearMin, yearMax] = filters.yearRange || [];
  if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && (yearMin > EARLIEST_YEAR || yearMax < LATEST_YEAR)) {
    params.set('yearMin', String(yearMin));
    params.set('yearMax', String(yearMax));
  }

  if (filters.sort) params.set('sort', filters.sort);
  if (filters.cpoOnly) params.set('cpo', 'true');
  if (filters.bodyStyle) params.set('bodyStyle', filters.bodyStyle);

  params.set('page', String(filters.page || 1));

  return requestListings(params, filters.signal);
}

async function requestListings(params, signal) {
  let res;
  try {
    res = await fetch(`/api/listings?${params.toString()}`, { signal });
  } catch (err) {
    // AbortError means a newer search superseded this one — let the caller
    // recognize it and stay silent rather than flashing an error.
    if (err?.name === 'AbortError') throw err;
    throw new ListingsError('Could not reach the listings service.', 'network');
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ListingsError(
      body?.message || `Listings request failed (${res.status}).`,
      body?.error || 'listings_error',
    );
  }

  return {
    listings: Array.isArray(body?.listings) ? body.listings : [],
    origin: body?.origin || null,
    page: body?.page || 1,
    total: body?.total ?? null,
    hasMore: Boolean(body?.hasMore),
  };
}

/**
 * Client-side refinements over an already-fetched page.
 *
 * Deliberately narrow: these are the filters the upstream API can't express
 * (mileage ceiling, source badge, trim substring) plus a radius re-check for
 * listings whose ZIP resolved to a point outside the requested circle. Anything
 * the API *can* filter is sent upstream instead, so we're not paginating
 * through inventory just to discard it locally.
 */
export function refineListings(listings, filters = {}) {
  if (!Array.isArray(listings)) return [];

  const { trimTokens } = parseQuery(filters.q);
  const [, mMax] = filters.mileageRange || [];
  const sources =
    Array.isArray(filters.sources) && filters.sources.length > 0
      ? new Set(filters.sources)
      : null;

  return listings.filter((l) => {
    if (Number.isFinite(mMax) && mMax > 0 && mMax < MILEAGE_CEILING) {
      // Unknown mileage is kept rather than dropped — a missing field
      // shouldn't look like a filtered-out car.
      if (Number.isFinite(l.mileage) && l.mileage > mMax) return false;
    }

    if (sources && !sources.has(l.dealer?.source)) return false;

    // Upstream matched make + model; these are the leftover tokens, which
    // narrow to a trim ("audi s5 sportback") without a second API call.
    if (trimTokens.length > 0) {
      const hay = `${l.model || ''} ${l.trim || ''}`.toLowerCase();
      if (!trimTokens.every((tok) => hay.includes(tok))) return false;
    }

    if (
      filters.radius &&
      filters.radius !== 'nationwide' &&
      filters.origin?.lat != null &&
      l.dealer?.lat != null
    ) {
      const d = distanceMiles(filters.origin.lat, filters.origin.lng, l.dealer.lat, l.dealer.lng);
      // 15% slack: the pin is a ZIP centroid, not the dealer's exact address,
      // so a strict compare drops legitimately in-range listings at the edge.
      if (d > filters.radius * 1.15) return false;
    }

    return true;
  });
}
