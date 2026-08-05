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

// Radius used for "Nationwide" when a ZIP is present — wide enough to cover
// the continental US plus Alaska and Hawaii from any origin. Reaches ~4.40M of
// the ~4.49M total listings; the ~2% shortfall is rows the feed has no location
// for, which a ZIP-scoped query can't return either way.
const NATIONWIDE_DISTANCE_MI = 3000;

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

/**
 * Download a listing photo and hand back a real `File`.
 *
 * The Analyze pipeline treats vehicle images as uploaded files — it runs them
 * through compressImageFiles() and FileReader, both of which need a Blob. A
 * plain `{ name, url }` object silently produces nothing, so anything feeding
 * the funnel has to materialise the bytes first.
 *
 * Goes through /api/listing-photo rather than fetching directly: the photo
 * host sets `access-control-allow-origin: https://ui.auto.dev`, which lets an
 * <img> render it but blocks a same-origin fetch.
 *
 * Returns null rather than throwing when the photo doesn't exist — the feed
 * builds these URLs from the VIN and a meaningful share of them 404, which is
 * an absent photo, not a failure worth interrupting the user for.
 */
export async function fetchListingPhotoAsFile(url, filename = 'listing-photo.jpg') {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch(`/api/listing-photo?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size || !blob.type.startsWith('image/')) return null;
    // Give it the extension the content-type actually implies, so downstream
    // compression and the Claude media_type agree.
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    const name = filename.replace(/\.[^.]+$/, '') + '.' + ext;
    return new File([blob], name, { type: blob.type });
  } catch {
    return null;
  }
}

/**
 * Fetch the model names Auto.dev actually has for a make, via its facets
 * (exact-match to the `vehicle.model` filter, unlike a generic VIN dataset).
 * Returns the top models by inventory volume, newest-selling first. Empty array
 * on any failure — the dropdown just falls back to "Any model".
 */
export async function fetchModelsForMake(make, signal, provider = 'cars') {
  const m = String(make || '').trim();
  if (!m) return [];
  // Cars → the dedicated /api/vehicle-models (Auto.dev facets). Motorcycles →
  // the same MarketCheck proxy that answers listings, via the ?modelsForMake
  // query parameter. Both return { models: string[] }.
  const url =
    provider === 'motorcycles'
      ? `/api/motorcycles?modelsForMake=${encodeURIComponent(m)}`
      : `/api/vehicle-models?make=${encodeURIComponent(m)}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    return Array.isArray(body?.models) ? body.models : [];
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return [];
  }
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

// Display-cased makes for the sidebar dropdown, matching Auto.dev's own casing
// (e.g. "BMW", "Mercedes-Benz"). Derived from the same set the query parser
// uses, so anything selectable here is a make the API actually recognizes.
export const MAKES_DISPLAY = [
  'Acura', 'Alfa Romeo', 'Aston Martin', 'Audi', 'Bentley', 'BMW', 'Buick',
  'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Ferrari', 'Fiat', 'Ford',
  'Genesis', 'GMC', 'Honda', 'Hummer', 'Hyundai', 'Infiniti', 'Jaguar', 'Jeep',
  'Kia', 'Lamborghini', 'Land Rover', 'Lexus', 'Lincoln', 'Lotus', 'Lucid',
  'Maserati', 'Mazda', 'McLaren', 'Mercedes-Benz', 'Mercury', 'Mini',
  'Mitsubishi', 'Nissan', 'Oldsmobile', 'Plymouth', 'Polestar', 'Pontiac',
  'Porsche', 'Ram', 'Rivian', 'Rolls-Royce', 'Saab', 'Saturn', 'Scion',
  'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo',
];

// Motorcycle makes for the sidebar dropdown when the panel is in bike mode.
// Ordered by MarketCheck facet volume (Kawasaki has the most listings), so the
// most-likely picks are at the top of the list. Not all of these will have big
// inventory — the Model dropdown loads per-make from the facet endpoint, so a
// low-count make just shows fewer models.
export const MOTORCYCLE_MAKES_DISPLAY = [
  'Kawasaki', 'Honda', 'Harley-Davidson', 'Yamaha', 'Polaris', 'Can-Am', 'Suzuki',
  'Ducati', 'BMW', 'Triumph', 'KTM', 'Indian', 'Aprilia', 'Vespa', 'Royal Enfield',
  'Husqvarna', 'Piaggio', 'MV Agusta', 'Zero', 'Beta', 'GasGas',
];

// Same lookup for bikes, built from the dropdown list so it can't drift.
const MOTORCYCLE_MAKES = new Set(MOTORCYCLE_MAKES_DISPLAY.map((m) => m.toLowerCase()));

// canonical/lowercase make ("audi", "mercedes-benz") → the display form the
// dropdown uses, or '' if it isn't a known make. Lets the dropdown stay in sync
// with whatever is in the search box (typed or set by the agent).
export function makeDisplayName(rawMake, provider) {
  const c = String(rawMake || '').toLowerCase().trim();
  const list = provider === 'motorcycles' ? MOTORCYCLE_MAKES_DISPLAY : MAKES_DISPLAY;
  return list.find((m) => m.toLowerCase() === c) || '';
}

// What people actually type vs. what the API expects.
const MAKE_ALIASES = {
  chevy: 'chevrolet', vw: 'volkswagen', mercedes: 'mercedes-benz',
  benz: 'mercedes-benz', 'mercedes benz': 'mercedes-benz', beemer: 'bmw',
  bimmer: 'bmw', 'land-rover': 'land rover', landrover: 'land rover',
  'rolls royce': 'rolls-royce', 'alfa': 'alfa romeo', vette: 'chevrolet',
};

const MOTORCYCLE_MAKE_ALIASES = {
  'harley': 'harley-davidson', 'harley davidson': 'harley-davidson',
  'h-d': 'harley-davidson', 'hd': 'harley-davidson',
  'royal-enfield': 'royal enfield', 'mv-agusta': 'mv agusta',
};

// Provider-aware: a query typed in Motorcycles mode should recognize bike
// makes ("yamaha", "kawasaki") instead of checking the car-only list, which
// misclassified them as models and sent nonsense upstream (e.g.
// vehicle.model=yamaha* against MarketCheck, which never matches).
const canonicalMake = (s, provider) => {
  const k = String(s || '').toLowerCase().trim();
  if (provider === 'motorcycles') {
    const aliased = MOTORCYCLE_MAKE_ALIASES[k] || k;
    return MOTORCYCLE_MAKES.has(aliased) ? aliased : null;
  }
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
// A model year written into the query, e.g. "2020 toyota camry" or
// "toyota camry 2020". Also accepts a range: "2018-2022 bmw".
//
// This has to be stripped BEFORE make/model parsing. "2020" isn't a known
// make, so the old parser fell through and used it as the model — turning
// "2020 toyota camry" into vehicle.model=2020*, which matches nothing.
const YEAR_RE = /^(19\d{2}|20\d{2})$/;
const YEAR_RANGE_RE = /^(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})$/;

const plausibleYear = (n) => Number.isFinite(n) && n >= EARLIEST_YEAR && n <= LATEST_YEAR;

export function parseQuery(raw, provider) {
  const q = String(raw || '').trim();
  const empty = { make: '', model: '', trimTokens: [], vin: '', yearMin: null, yearMax: null };
  if (!q) return empty;
  if (VIN_RE.test(q)) return { ...empty, vin: q.toUpperCase() };

  let parts = q.split(/\s+/);

  // Pull out a year or year range from anywhere in the query, and drop those
  // tokens so they can't be mistaken for a make or model.
  let yearMin = null;
  let yearMax = null;
  parts = parts.filter((tok) => {
    const range = tok.match(YEAR_RANGE_RE);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (plausibleYear(a) && plausibleYear(b)) {
        yearMin = Math.min(a, b);
        yearMax = Math.max(a, b);
        return false;
      }
    }
    if (YEAR_RE.test(tok)) {
      const n = Number(tok);
      if (plausibleYear(n)) {
        // Repeated years widen into a range: "2018 2020 camry" → 2018-2020.
        yearMin = yearMin == null ? n : Math.min(yearMin, n);
        yearMax = yearMax == null ? n : Math.max(yearMax, n);
        return false;
      }
    }
    return true;
  });

  // Longest-match-first so two-word makes beat their first token.
  const twoWord = parts.length >= 2 ? canonicalMake(`${parts[0]} ${parts[1]}`, provider) : null;
  const oneWord = canonicalMake(parts[0], provider);

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
    yearMin,
    yearMax,
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
  const { make, model, trimTokens, vin, yearMin: qYearMin, yearMax: qYearMax } = parseQuery(filters.q, filters.provider);

  // Provider routing: 'motorcycles' hits MarketCheck (bikes), anything else
  // (default) hits Auto.dev (cars). The endpoints share the same normalized
  // Listing shape so the UI doesn't need to branch on which one answered.
  const isMoto = filters.provider === 'motorcycles';
  const endpoint = isMoto ? '/api/motorcycles' : '/api/listings';

  const base = new URLSearchParams();
  if (vin && !isMoto) {
    // A VIN search is exact — every other filter is noise, so send it alone
    // and let the server hit Auto.dev's single-listing endpoint. Motorcycles
    // don't have a VIN-lookup endpoint on MarketCheck, so fall through and use
    // it as a normal query token instead.
    base.set('vin', vin);
    return requestListings(base, filters.signal, endpoint);
  }
  if (make) base.set('make', make);

  const zip = String(filters.zip || '').trim();
  if (/^\d{5}$/.test(zip)) {
    base.set('zip', zip);
    // `distance` MUST be sent explicitly whenever a ZIP is present. Omitting it
    // does not mean "no radius" — Auto.dev defaults to 50 miles, so picking
    // "Nationwide" with a ZIP entered silently stayed a 50-mile search
    // (verified: zip alone and zip+distance=50 both return 77,250 rows).
    //
    // For Nationwide we send a continent-spanning radius rather than dropping
    // the ZIP, because the ZIP is also what makes the feed return coordinates
    // at all — without it every listing comes back at [0,0] and the map empties.
    base.set('distance', filters.radius && filters.radius !== 'nationwide'
      ? String(filters.radius)
      : String(NATIONWIDE_DISTANCE_MI));
  }

  const [priceMin, priceMax] = filters.priceRange || [];
  // The panel's price slider tops out at its max value, which means "no
  // ceiling" rather than a literal cap — sending it would exclude anything
  // above it, so an at-max slider is treated as unset.
  if (Number.isFinite(priceMax) && priceMax > 0 && priceMax < PRICE_CEILING) {
    base.set('priceMin', String(priceMin || 0));
    base.set('priceMax', String(priceMax));
  }

  // Year is a genuine upstream range filter (`vehicle.year=2018-2024`), so it
  // narrows the query rather than the page.
  //
  // A year typed into the search box wins over the sidebar dropdowns: someone
  // who types "2020 camry" while the sidebar still says 1990-2027 means the
  // 2020, and intersecting the two would just be a confusing no-op here.
  const [sliderMin, sliderMax] = filters.yearRange || [];
  const yearMin = qYearMin ?? sliderMin;
  const yearMax = qYearMax ?? sliderMax;
  // Only sent when actually narrower than the full span — otherwise it's noise
  // on every request.
  if (Number.isFinite(yearMin) && Number.isFinite(yearMax) && (yearMin > EARLIEST_YEAR || yearMax < LATEST_YEAR)) {
    base.set('yearMin', String(yearMin));
    base.set('yearMax', String(yearMax));
  }

  // Mileage — sent server-side when there's an actual ceiling (an at-max
  // slider means "any", so it's omitted and costs no filtering).
  const [mileMin, mileMax] = filters.mileageRange || [];
  if (Number.isFinite(mileMax) && mileMax > 0 && mileMax < MILEAGE_CEILING) {
    base.set('milesMin', String(mileMin || 0));
    base.set('milesMax', String(mileMax));
  }

  if (filters.sort) base.set('sort', filters.sort);
  if (filters.cpoOnly) base.set('cpo', 'true');
  if (filters.condition === 'new' || filters.condition === 'used') base.set('condition', filters.condition);
  if (filters.bodyStyle) base.set('bodyStyle', filters.bodyStyle);
  // State + color: used mainly by the vehicle-finder agent (NL → filters).
  if (filters.state) base.set('state', filters.state);
  if (filters.color) base.set('color', filters.color);

  base.set('page', String(filters.page || 1));

  if (!model) {
    return requestListings(base, filters.signal, endpoint);
  }

  // Primary attempt: the typed token(s) as a model. The server prefix-matches
  // this upstream (see functions/api/listings.js), so "camr" already matches
  // "Camry" without the user finishing the word.
  const modelAttempt = new URLSearchParams(base);
  modelAttempt.set('model', model);
  const result = await requestListings(modelAttempt, filters.signal, endpoint);
  if (result.listings.length > 0) return result;

  // Fallback: the token may not be a model at all. A BMW "M340i" is
  // vehicle.model="3 Series" + vehicle.trim="M340i" upstream — nothing in the
  // model field starts with "m340i", so the primary attempt above comes back
  // empty even though the car exists. Retry the same remainder as a trim
  // filter instead. This only runs on a genuine zero-result search, so the
  // common case (an actual model name) still costs one call, not two.
  const trimCandidate = [model, ...trimTokens].join(' ').trim();
  const trimAttempt = new URLSearchParams(base);
  trimAttempt.set('trim', trimCandidate);
  try {
    const trimResult = await requestListings(trimAttempt, filters.signal, endpoint);
    if (trimResult.listings.length > 0) return trimResult;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // The primary attempt already succeeded (if emptily) — a failure on this
    // speculative retry shouldn't override a valid empty result with an error.
  }

  // Motorcycle-only fallback: MarketCheck splits a mashed model+trim token at
  // the letter/digit boundary — "CRF300L" is model="Crf" + trim="300l Abs" —
  // so neither the model-only nor whole-token-as-trim attempts above match
  // (verified live: both return 0; model="Crf" + trim="300l" returns 250).
  // Cars don't need this: Auto.dev's trim fallback already matches on the
  // full remainder ("M340i"), so this only runs for bikes.
  if (isMoto) {
    const split = model.match(/^([a-zA-Z]+)([0-9].*)$/);
    if (split) {
      const splitAttempt = new URLSearchParams(base);
      splitAttempt.set('model', split[1]);
      splitAttempt.set('trim', [split[2], ...trimTokens].join(' ').trim());
      try {
        const splitResult = await requestListings(splitAttempt, filters.signal, endpoint);
        if (splitResult.listings.length > 0) return splitResult;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
      }
    }
  }

  return result;
}

async function requestListings(params, signal, endpoint = '/api/listings') {
  let res;
  try {
    res = await fetch(`${endpoint}?${params.toString()}`, { signal });
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
