// Find Me a Car — search-listings surface that funnels into the Buy
// flow. Backed by live dealer inventory through /api/listings; there is
// no sample-data mode, so every card on screen is a real vehicle.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────────┐
//   │  Filters (left, ~280px)  │  Map (top)                          │
//   │                          ├─────────────────────────────────────┤
//   │  ZIP · Distance ·        │  Listing grid (cards, 3-4 cols)     │
//   │  Sources · Price ·       │                                     │
//   │  Mileage · q             │                                     │
//   └────────────────────────────────────────────────────────────────┘
//
// Card ↔ pin hover sync: hovering a card highlights the matching map
// pin (larger icon + price label); hovering a pin highlights the card
// (scrolls into view + glow). Both directions wired off shared
// hoveredVin state.
//
// "Analyze" CTA on every card: switches activeMode to 'buy', pre-fills
// the chat input with the vehicle's details and triggers the analysis
// through the existing pipeline. That's the actual product thesis —
// Find is the funnel into Buy, not a parallel feature.
//
// Request discipline matters here: the free Auto.dev tier is 1,000 calls
// a month, so searches are debounced, superseded requests are aborted,
// and the filters that don't need a round-trip (mileage, source badge,
// trim) refine the fetched page client-side instead.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Search, Heart, Sparkles, ExternalLink, ArrowLeft, MapPin,
  Loader2, AlertCircle, RefreshCw, SlidersHorizontal, X,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import {
  DISTANCE_OPTIONS,
  SOURCE_LABELS,
  PRICE_CEILING,
  MILEAGE_CEILING,
  EARLIEST_YEAR,
  LATEST_YEAR,
  fetchListings,
  refineListings,
} from '../utils/listings';

// Suppress Leaflet's default-marker requests (we use DivIcons exclusively).
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: '', iconUrl: '', shadowUrl: '' });

const US_CENTER = [39.5, -98.35];

// Map pane sizing, as a fraction of the available column height.
//
// This is continuous rather than stepped. Discrete stops with a cooldown meant
// one flick moved one notch and everything in between was a wait, which reads
// as unresponsive. Tying the height directly to wheel delta makes the map track
// the gesture 1:1 — the standard collapsing-header feel — so scrolling alone is
// enough and no buttons are needed.
const MAP_MIN_FRAC = 0.12;
const MAP_MAX_FRAC = 0.75;
const MAP_DEFAULT_FRAC = 0.4;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const FAVORITES_KEY = 'vincritiq.find.favorites';

// Basemap palettes. The tile URL, the container background (visible while
// tiles stream in, and in the gutters past the map edges), and the pin outline
// all have to move together — a white pin ring vanishes on CARTO's light
// basemap, and a slate-900 backdrop flashes dark behind a light map on every
// pan.
const MAP_THEME = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    background: '#0f172a',
    pinRing: '#ffffff',
    pinShadow: 'rgba(0,0,0,0.4)',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    background: '#e8e6e1',
    pinRing: '#1a1a18',
    pinShadow: 'rgba(0,0,0,0.25)',
  },
};

// Sort options map onto Auto.dev's `sort` param (field.direction). Only the
// fields the API documents as sortable are offered — an unsupported field is
// rejected upstream rather than silently ignored.
const SORT_OPTIONS = [
  { id: 'updatedAt.desc', label: 'Freshest listings' },
  { id: 'price.asc', label: 'Price: low to high' },
  { id: 'price.desc', label: 'Price: high to low' },
  { id: 'miles.asc', label: 'Mileage: lowest first' },
  { id: 'year.desc', label: 'Year: newest first' },
];

// Body styles that actually have inventory behind them. `vehicle.bodyStyle`
// isn't in Auto.dev's published param list but works, and these four cover
// essentially the whole catalogue (SUV 2.4M, Truck 950k, Van 63k, plus Car).
// Coupe and Convertible are valid values but return ~2k rows each out of 4.4M,
// which reads as a broken filter rather than a niche one.
const BODY_STYLES = ['Car', 'SUV', 'Truck', 'Van'];

// Newest year first — most shoppers filter down from recent, not up from 1990.
const YEAR_CHOICES = Array.from(
  { length: LATEST_YEAR - EARLIEST_YEAR + 1 },
  (_, i) => LATEST_YEAR - i,
);


// Plain dot pin for normal state, large price-tagged pill for the
// currently-hovered listing. The hovered state has to look noticeably
// different (size + price label) so the user's eye can follow the
// hover → pin connection at a glance.
function listingPin({ hovered, price, source, theme = 'dark' }) {
  const color = SOURCE_LABELS[source]?.color || '#2563eb';
  const { pinRing, pinShadow } = MAP_THEME[theme];
  if (hovered) {
    const dollars =
      price == null ? '—' : price >= 1000 ? `$${Math.round(price / 1000)}K` : `$${price}`;
    return L.divIcon({
      className: 'find-pin find-pin-hovered',
      html: `<div style="
        background:${color};
        color:#fff;
        font-size:11px;
        font-weight:700;
        padding:4px 8px;
        border-radius:999px;
        border:2px solid ${pinRing};
        box-shadow:0 4px 12px ${pinShadow};
        white-space:nowrap;
        transform:translateY(-2px);
      ">${dollars}</div>`,
      iconSize: [60, 24],
      iconAnchor: [30, 24],
    });
  }
  return L.divIcon({
    className: 'find-pin',
    html: `<div style="
      width:12px;
      height:12px;
      border-radius:50%;
      background:${color};
      border:2px solid ${pinRing};
      box-shadow:0 0 0 1px ${pinShadow};
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function formatMiles(n) {
  if (!Number.isFinite(n)) return 'Mileage n/a';
  return `${n.toLocaleString()} mi`;
}

function formatPrice(n) {
  if (!Number.isFinite(n)) return 'Call for price';
  return `$${n.toLocaleString()}`;
}

// Recenters the map when a new search resolves. MapContainer only reads
// `center` on mount, so without this the view stays wherever the previous
// search left it and a ZIP change looks like it did nothing.
function MapFocus({ listings, origin }) {
  const map = useMap();
  useEffect(() => {
    const points = listings
      .filter((l) => Number.isFinite(l.dealer?.lat) && Number.isFinite(l.dealer?.lng))
      .map((l) => [l.dealer.lat, l.dealer.lng]);

    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 11 });
    } else if (points.length === 1) {
      map.setView(points[0], 10);
    } else if (origin?.lat != null) {
      map.setView([origin.lat, origin.lng], 9);
    } else {
      map.setView(US_CENTER, 4);
    }
  }, [listings, origin, map]);
  return null;
}

// Leaflet caches its container dimensions and only recomputes them on a window
// resize. Growing or shrinking the map pane in JS therefore leaves it rendering
// at the old size — grey bands where tiles should be, and clicks landing on the
// wrong coordinates. invalidateSize() after the CSS transition settles is what
// keeps the tiles honest.
function MapResizer({ trigger }) {
  const map = useMap();
  useEffect(() => {
    // Scheduling on rAF and cancelling on cleanup naturally throttles this to
    // at most one invalidateSize per frame, however many wheel ticks arrive.
    const raf = requestAnimationFrame(() => map.invalidateSize({ animate: false, pan: false }));
    return () => cancelAnimationFrame(raf);
  }, [trigger, map]);
  return null;
}

// Tiny chip used in the filter sidebar (distance radius, source kind).
function FilterPill({ active, onClick, children, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="px-2.5 py-1 rounded-full text-xs font-medium transition-all whitespace-nowrap"
      style={{
        background: active ? 'var(--color-accent)' : 'var(--color-bg)',
        color: active ? '#fff' : 'var(--color-text)',
        border: active ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// Single listing card. Wrapped in its own component so the
// hover/leave handlers don't force the entire grid to re-render
// whenever the cursor moves.
function ListingCard({ listing, hovered, favorited, onHover, onLeave, onAnalyze, onFavorite, onPhotoResolved, cardRefSetter }) {
  const sourceMeta =
    SOURCE_LABELS[listing.dealer?.source] || { label: listing.dealer?.name || 'Listing', color: '#64748b' };
  const photo = Array.isArray(listing.photos) ? listing.photos[0] : null;
  // Three states, not two. The old boolean showed the "Photo unavailable"
  // placeholder during loading as well as after a failure, so a photo that was
  // merely slow looked identical to one that was missing. Now the card spins
  // until the image resolves and only calls it unavailable once it actually
  // errors.
  const [photoState, setPhotoState] = useState(photo ? 'loading' : 'missing');

  // Report the outcome upward so the panel can sink photo-less listings to the
  // bottom. The feed's image URLs are VIN-derived guesses and many 404, and
  // there's no way to know which without asking the browser to try — the host
  // doesn't answer HEAD requests.
  useEffect(() => {
    if (photoState === 'loading') return;
    onPhotoResolved?.(listing.vin, photoState !== 'failed' && photoState !== 'missing');
  }, [photoState, listing.vin, onPhotoResolved]);

  // The feed gives a dealer name but no city/state, so the meta line falls back
  // to the seller rather than rendering an orphaned comma.
  const place =
    [listing.dealer?.city, listing.dealer?.state].filter(Boolean).join(', ') ||
    listing.dealer?.name ||
    '';

  return (
    <div
      ref={cardRefSetter}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className="rounded-xl overflow-hidden transition-all"
      style={{
        background: 'var(--color-surface)',
        border: hovered ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
        boxShadow: hovered ? '0 8px 24px rgba(37,99,235,0.25)' : '0 1px 2px rgba(0,0,0,0.05)',
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
      }}
    >
      <div
        className="relative w-full"
        style={{
          aspectRatio: '16 / 10',
          background: 'linear-gradient(135deg, rgba(100,116,139,0.15), rgba(100,116,139,0.06))',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        {photo && photoState !== 'failed' && (
          <img
            src={photo}
            alt={`${listing.year || ''} ${listing.make || ''} ${listing.model || ''}`.trim()}
            loading="lazy"
            onLoad={() => setPhotoState('loaded')}
            // Dealer photo hosts break links constantly — the feed builds
            // image URLs from the VIN and a fair number 404. Falling back to a
            // placeholder keeps the card intact instead of showing a broken
            // image icon.
            onError={() => setPhotoState('failed')}
            className="absolute inset-0 w-full h-full"
            style={{
              objectFit: 'cover',
              // Fade in so a loaded photo replaces the spinner smoothly rather
              // than snapping in.
              opacity: photoState === 'loaded' ? 1 : 0,
              transition: 'opacity 220ms ease',
            }}
          />
        )}

        {photoState === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center" aria-label="Loading photo">
            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-muted)', opacity: 0.6 }} />
          </div>
        )}

        {(photoState === 'failed' || photoState === 'missing') && (
          <div
            className="absolute inset-0 flex items-center justify-center text-xs font-semibold"
            style={{ color: 'var(--color-muted)', opacity: 0.5 }}
          >
            No photos
          </div>
        )}
        <span
          className="absolute top-2 left-2 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white"
          style={{ background: sourceMeta.color }}
        >
          {sourceMeta.label}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onFavorite(); }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-110"
          style={{
            background: 'rgba(0,0,0,0.55)',
            color: favorited ? '#ef4444' : '#fff',
            backdropFilter: 'blur(6px)',
          }}
          title={favorited ? 'Remove from saved' : 'Save listing'}
          aria-label={favorited ? 'Remove from saved' : 'Save listing'}
        >
          <Heart size={13} fill={favorited ? '#ef4444' : 'none'} />
        </button>
        <div
          className="absolute bottom-2 left-2 text-white font-bold text-lg px-2.5 py-1 rounded-md"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
        >
          {formatPrice(listing.price)}
        </div>
      </div>

      <div className="p-3">
        <div className="font-semibold text-sm leading-tight" style={{ color: 'var(--color-text)' }}>
          {[listing.year, listing.make, listing.model].filter(Boolean).join(' ') || 'Vehicle'}
        </div>
        {listing.trim && (
          <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-muted)' }}>{listing.trim}</div>
        )}
        <div className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: 'var(--color-muted)' }}>
          <span>{formatMiles(listing.mileage)}</span>
          {place && <><span>·</span><span className="truncate">{place}</span></>}
        </div>

        <div className="flex items-center gap-1.5 mt-3">
          <button
            onClick={onAnalyze}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: 'var(--color-accent)' }}
          >
            <Sparkles size={11} />
            Analyze
          </button>
          {listing.listingUrl && (
            <a
              href={listing.listingUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-all hover:opacity-80"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}
              title="Open original listing"
            >
              <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FindACarPanel({ onAnalyzeListing, onBack }) {
  // Basemap follows the app theme. Falls back to dark if the provider is
  // somehow absent so the map never renders untiled.
  const { dark } = useTheme() || { dark: true };
  const tileTheme = dark ? 'dark' : 'light';

  // ── Filter state ──────────────────────────────────────────────────
  const [q, setQ] = useState('');
  const [zip, setZip] = useState('');
  const [radius, setRadius] = useState('nationwide');
  const [priceRange, setPriceRange] = useState([0, PRICE_CEILING]);
  const [mileageRange, setMileageRange] = useState([0, MILEAGE_CEILING]);
  const [activeSources, setActiveSources] = useState([]); // [] = all
  const [yearRange, setYearRange] = useState([EARLIEST_YEAR, LATEST_YEAR]);
  const [sort, setSort] = useState('updatedAt.desc');
  const [cpoOnly, setCpoOnly] = useState(false);
  const [bodyStyle, setBodyStyle] = useState('');  // '' = any

  // ── Data state ────────────────────────────────────────────────────
  const [rawListings, setRawListings] = useState([]);
  const [origin, setOrigin] = useState(null);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // Bumped only by a fresh search, never by "Load more". Photo-ordering state
  // keys off this so an append doesn't wipe what page 1 already resolved.
  const [searchEpoch, setSearchEpoch] = useState(0);

  // ── UI state ──────────────────────────────────────────────────────
  const [hoveredVin, setHoveredVin] = useState(null);
  const [geoLocating, setGeoLocating] = useState(false);
  // Saved listings are stored as full objects, not just VINs.
  //
  // A VIN set was only usable while the listing happened to be in the current
  // result set — save a car, search something else, and the favourite pointed
  // at nothing. Keeping the whole record means the saved view works no matter
  // what's on screen, and survives a reload via localStorage.
  //
  // localStorage rather than Firestore because saving shouldn't require an
  // account. Moving this to the user doc later would make it sync across
  // devices; the shape is already a plain array of listings.
  const [favorites, setFavorites] = useState(() => {
    try {
      const raw = window.localStorage.getItem(FAVORITES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Map(Array.isArray(parsed) ? parsed.filter((l) => l?.vin).map((l) => [l.vin, l]) : []);
    } catch {
      return new Map(); // corrupt or unavailable storage shouldn't break the panel
    }
  });
  const [viewingFavorites, setViewingFavorites] = useState(false);
  // Phone-only: the filter rail is an off-canvas sheet below md.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // A couple of strings have to shorten on phones, and text content can't be
  // swapped with a CSS breakpoint the way layout can. Tracked in JS against
  // the same 640px boundary Tailwind's `sm` uses.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites.values()]));
    } catch {
      // Quota exceeded or private mode — saving still works for this session.
    }
  }, [favorites]);
  const [mapFrac, setMapFrac] = useState(MAP_DEFAULT_FRAC);
  const cardRefs = useRef(new Map());
  const abortRef = useRef(null);
  const gridRef = useRef(null);
  const columnRef = useRef(null);
  // The wheel handler is a native non-passive listener (see below) and can't
  // re-subscribe on every render, so it reads the live value through a ref.
  const mapFracRef = useRef(MAP_DEFAULT_FRAC);
  useEffect(() => { mapFracRef.current = mapFrac; }, [mapFrac]);

  // Collapsing-header behaviour: while the listing grid is scrolled to the top,
  // the wheel resizes the map instead of scrolling the list. Scroll up to grow
  // it, down to shrink it, and once it bottoms out the wheel goes back to
  // scrolling listings normally. One continuous surface, no buttons.
  //
  // This has to be a native listener with { passive: false }: React's onWheel
  // is registered passively, so preventDefault() there is a no-op and the list
  // would scroll underneath the resize.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return undefined;

    const onWheel = (e) => {
      if (el.scrollTop > 0) return;              // reading the list — leave it alone
      const growing = e.deltaY < 0;
      const frac = mapFracRef.current;
      // Nothing left to give in this direction: release the gesture to the list
      // rather than swallowing it.
      if (growing && frac >= MAP_MAX_FRAC) return;
      if (!growing && frac <= MAP_MIN_FRAC) return;

      const columnHeight = columnRef.current?.clientHeight || window.innerHeight;
      e.preventDefault();
      setMapFrac(clamp(frac - e.deltaY / columnHeight, MAP_MIN_FRAC, MAP_MAX_FRAC));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toggleSource = (s) => {
    setActiveSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };
  const toggleFavorite = (listing) => {
    setFavorites((prev) => {
      const next = new Map(prev);
      if (next.has(listing.vin)) next.delete(listing.vin);
      else next.set(listing.vin, listing);
      return next;
    });
  };

  const zipValid = /^\d{5}$/.test(zip.trim());

  // Only the filters that require a server round-trip belong here. Mileage,
  // source, and trim are applied locally by refineListings, so typing in
  // those controls costs nothing against the monthly API quota.
  const serverFilters = useMemo(
    () => ({
      q,
      zip: zipValid ? zip.trim() : '',
      radius,
      priceRange,
      yearRange,
      sort,
      cpoOnly,
      bodyStyle,
    }),
    [q, zip, zipValid, radius, priceRange, yearRange, sort, cpoOnly, bodyStyle],
  );

  const runSearch = useCallback(async (filters, nextPage, { append } = {}) => {
    // Abort whatever is in flight — with a debounced search box the previous
    // request is always stale, and letting it resolve would clobber the newer
    // results out of order.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (append) setLoadingMore(true); else { setLoading(true); setSearchEpoch((n) => n + 1); }
    setError(null);

    try {
      const result = await fetchListings({ ...filters, page: nextPage, signal: controller.signal });
      setRawListings((prev) => (append ? [...prev, ...result.listings] : result.listings));
      setOrigin(result.origin);
      setTotal(result.total);
      // Upstream keeps advertising a `next` link past its pagination depth
      // limit, where it then serves empty pages. An empty result is the real
      // end of the road regardless of what the envelope claims.
      setHasMore(result.hasMore && result.listings.length > 0);
      setPage(result.page);
    } catch (err) {
      if (err?.name === 'AbortError') return; // superseded; the newer search owns the UI
      setError({ message: err?.message || 'Something went wrong.', code: err?.code });
      if (!append) setRawListings([]);
    } finally {
      if (controller === abortRef.current) {
        setLoadingMore(false);
        setLoading(false);
      }
    }
  }, []);

  // Debounced search on every server-relevant filter change. 450ms is long
  // enough that typing "toyota camry" is one request rather than twelve.
  useEffect(() => {
    const t = setTimeout(() => { runSearch(serverFilters, 1); }, 450);
    return () => clearTimeout(t);
  }, [serverFilters, runSearch]);

  // Cancel any in-flight request when the panel unmounts, so a resolved
  // fetch can't setState on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Ask the browser for the user's location and reverse it into a ZIP, so
  // radius search works without the user knowing their own postal code.
  //
  // BigDataCloud's reverse-geocode-client endpoint is key-less, CORS-enabled,
  // and free for exactly this browser-side use — unlike Zippopotam (which is
  // forward-only) or Nominatim (which asks you not to call it from a browser
  // at volume).
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    setGeoLocating(true);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await fetch(
            'https://api.bigdatacloud.net/data/reverse-geocode-client' +
              `?latitude=${coords.latitude}&longitude=${coords.longitude}&localityLanguage=en`,
          );
          if (!res.ok) throw new Error('reverse geocode failed');
          const data = await res.json();
          const found = String(data?.postcode || '').match(/\d{5}/)?.[0];
          if (found) { setZip(found); setRadius(100); }
        } catch {
          // Silent: the ZIP box is right there and still works by hand.
        } finally {
          setGeoLocating(false);
        }
      },
      () => setGeoLocating(false),
      { timeout: 8000 },
    );
  }, []);

  // ── Photo-first ordering ──────────────────────────────────────────
  //
  // A card can only learn its photo is a dead link by trying to load it, so the
  // ordering can't be decided up front. Cards report in as they resolve, and
  // the result is applied on a short debounce: without it, twenty images
  // resolving at slightly different moments would reshuffle the grid twenty
  // times under the user's cursor. One settle, one reflow.
  const [photoMisses, setPhotoMisses] = useState(() => new Set());
  const [orderKey, setOrderKey] = useState(() => new Set());
  // Reordering is only allowed to happen while this window is open — the first
  // couple of seconds after a fresh search, when the visible cards are
  // resolving. Images below the fold load lazily as the user scrolls, and
  // without the window those late resolutions would yank cards around long
  // after the page settled.
  const [sortWindowOpen, setSortWindowOpen] = useState(true);

  const handlePhotoResolved = useCallback((vin, hasPhoto) => {
    if (hasPhoto) return; // only misses affect ordering
    setPhotoMisses((prev) => (prev.has(vin) ? prev : new Set(prev).add(vin)));
  }, []);

  // A new search invalidates what we learned; appending a page does not.
  // Resetting on every rawListings change would discard the misses already
  // known for page 1, and the cards for those listings are still mounted so
  // they'd never re-report — the photo-less ones would silently float back up.
  useEffect(() => {
    setPhotoMisses(new Set());
    setOrderKey(new Set());
    setSortWindowOpen(true);
    const t = setTimeout(() => setSortWindowOpen(false), 2500);
    return () => clearTimeout(t);
  }, [searchEpoch]);

  useEffect(() => {
    if (!sortWindowOpen) return undefined;
    const t = setTimeout(() => setOrderKey(photoMisses), 350);
    return () => clearTimeout(t);
  }, [photoMisses, sortWindowOpen]);

  // ── Local refinements over the fetched page ───────────────────────
  const listings = useMemo(() => {
    const refined = refineListings(rawListings, { q, mileageRange, sources: activeSources, radius, origin });
    // Stable partition rather than a comparator sort: everything keeps its
    // relative order, the known-photoless simply move to the end.
    const withPhotos = [];
    const without = [];
    for (const l of refined) {
      (orderKey.has(l.vin) ? without : withPhotos).push(l);
    }
    return [...withPhotos, ...without];
  }, [rawListings, q, mileageRange, activeSources, radius, origin, orderKey]);

  // ── Map ↔ card hover sync helpers ─────────────────────────────────
  const handlePinHover = (vin) => {
    setHoveredVin(vin);
    const node = cardRefs.current.get(vin);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // The saved view is a straight swap of the collection everything else renders
  // from — grid, map pins, and counter all follow it, so no branching downstream.
  const savedListings = useMemo(() => [...favorites.values()].reverse(), [favorites]);
  const displayed = viewingFavorites ? savedListings : listings;

  const mappable = useMemo(
    () => displayed.filter((l) => Number.isFinite(l.dealer?.lat) && Number.isFinite(l.dealer?.lng)),
    [displayed],
  );

  // Source pills are derived from the fetched page rather than hardcoded, so
  // the UI never offers a filter that can't match anything. Ordered by
  // SOURCE_LABELS so the pills don't reshuffle between searches.
  const availableSources = useMemo(() => {
    const present = new Set(rawListings.map((l) => l.dealer?.source).filter(Boolean));
    return Object.keys(SOURCE_LABELS).filter((id) => present.has(id));
  }, [rawListings]);

  // Drop any active source filter that the new result set can't satisfy —
  // otherwise a stale selection silently filters the whole grid to empty.
  useEffect(() => {
    setActiveSources((prev) => {
      const next = prev.filter((s) => availableSources.includes(s));
      return next.length === prev.length ? prev : next;
    });
  }, [availableSources]);

  const notConfigured = error?.code === 'listings_not_configured';

  return (
    // NOTE: the sheet + backdrop below use `absolute`, not `fixed`.
    // .mode-track carries a transform, which makes it the containing block
    // for fixed-position descendants — a `fixed` sheet was being positioned
    // against the 200%-wide track and landed off-screen. Anchoring to this
    // panel instead keeps it where the user can see it.
    <div className="flex flex-col h-full relative overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      {/* Top toolbar: back button + search box. Find takes over the
          full canvas (sidebar + tabs are hidden by the parent), so this
          row is the user's only navigation affordance back to chat. */}
      <div className="flex-shrink-0 px-3 md:px-6 py-3 md:py-4 flex items-center gap-2 md:gap-3 safe-top" style={{ borderBottom: '1px solid var(--color-border)' }}>
        {typeof onBack === 'function' && (
          <button
            onClick={onBack}
            title="Back to chat"
            aria-label="Back to chat"
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold transition-all hover:opacity-80"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            <ArrowLeft size={13} />
            <span className="hidden sm:inline">Back</span>
          </button>
        )}
        <div className="flex-1 max-w-2xl mx-auto relative">
          {loading ? (
            <Loader2
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 animate-spin"
              style={{ color: 'var(--color-accent)' }}
            />
          ) : (
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-muted)' }} />
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isNarrow ? "Search make, model, or VIN" : "Search by make and model — e.g. “Toyota Camry” — or paste a VIN"}
            className="w-full pl-9 pr-3 py-2.5 rounded-full text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          />
        </div>

        <button
          onClick={() => setFiltersOpen(true)}
          aria-label="Show filters"
          className="md:hidden flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 rounded-full text-xs font-semibold"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        >
          <SlidersHorizontal size={13} />
        </button>

        {/* Saved listings. Doubles as the toggle into the saved-only view, so
            the heart on each card has somewhere to lead. */}
        <button
          onClick={() => setViewingFavorites((v) => !v)}
          title={viewingFavorites ? 'Back to search results' : 'View saved listings'}
          aria-label={viewingFavorites ? 'Back to search results' : 'View saved listings'}
          aria-pressed={viewingFavorites}
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold transition-all hover:opacity-80"
          style={{
            background: viewingFavorites ? 'var(--color-accent)' : 'var(--color-surface)',
            border: `1px solid ${viewingFavorites ? 'var(--color-accent)' : 'var(--color-border)'}`,
            color: viewingFavorites ? '#fff' : 'var(--color-text)',
          }}
        >
          <Heart
            size={13}
            fill={favorites.size > 0 ? (viewingFavorites ? '#fff' : '#ef4444') : 'none'}
            color={viewingFavorites ? '#fff' : favorites.size > 0 ? '#ef4444' : 'currentColor'}
          />
          <span className="hidden sm:inline">Saved</span>
          {favorites.size > 0 && (
            <span
              className="inline-flex items-center justify-center rounded-full text-[10px] font-bold px-1.5"
              style={{
                minWidth: 17,
                height: 17,
                background: viewingFavorites ? 'rgba(255,255,255,0.25)' : 'var(--color-accent)',
                color: '#fff',
              }}
            >
              {favorites.size}
            </span>
          )}
        </button>
      </div>

      {/* Main 3-pane layout */}
      {filtersOpen && (
        <div
          className="md:hidden absolute inset-0"
          style={{ background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}
          onClick={() => setFiltersOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Filters sidebar */}
        {/* Filters. A 260px rail alongside a map and a card grid doesn't fit a
            phone, so below md it becomes an off-canvas sheet toggled by the
            Filters button in the toolbar. */}
        <aside
          className={[
            'flex-shrink-0 overflow-y-auto',
            'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-2xl',
          ].join(' ')}
          // The open/closed transform is an inline style rather than Tailwind
          // translate utilities. Toggling between `translate-x-0` and
          // `-translate-x-full` in the same variant leaves two equal-specificity
          // rules whose winner depends on Tailwind's emit order, not on the
          // order they're listed here — in practice the sheet stayed parked at
          // -100% even with only the open class applied. Inline wins outright.
          style={{
            width: 260,
            borderRight: '1px solid var(--color-border)',
            background: 'var(--color-surface)',
            ...(isNarrow
              ? {
                  transform: filtersOpen ? 'translateX(0)' : 'translateX(-100%)',
                  transition: 'transform 200ms ease',
                  // Above Leaflet. Its internal panes run to z-index 800 inside
                  // the map's stacking context, so a modest z-45 sheet was
                  // being painted over by the tiles.
                  zIndex: 1001,
                }
              : null),
          }}
        >
          <div className="p-4 space-y-5 safe-bottom">
            <button
              onClick={() => setFiltersOpen(false)}
              className="md:hidden w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              <X size={13} />
              Close filters
            </button>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Location</div>
              <div className="flex items-center gap-1.5">
                <input
                  value={zip}
                  onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  placeholder="ZIP code"
                  inputMode="numeric"
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
                <button
                  onClick={useMyLocation}
                  disabled={geoLocating}
                  title="Use my location"
                  aria-label="Use my location"
                  className="flex-shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center transition-all hover:opacity-80"
                  style={{ border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}
                >
                  {geoLocating ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />}
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Distance</div>
              <div className="flex flex-wrap gap-1.5">
                {DISTANCE_OPTIONS.map((opt) => (
                  <FilterPill
                    key={opt.id}
                    active={radius === opt.id}
                    onClick={() => setRadius(opt.id)}
                    disabled={opt.id !== 'nationwide' && !zipValid}
                    title={opt.id !== 'nationwide' && !zipValid ? 'Enter a ZIP code first' : undefined}
                  >
                    {opt.label}
                  </FilterPill>
                ))}
              </div>
              {!zipValid && radius !== 'nationwide' && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--color-muted)', opacity: 0.7 }}>
                  Enter a ZIP code to search by radius.
                </p>
              )}
            </div>

            {/* Only offer sources that actually appear in the current results.
                The Starter feed is overwhelmingly Carvana inventory, so a fixed
                CarMax / Dealer / Private Seller pill row would have been three
                buttons that always return nothing. Hidden entirely when there's
                only one source to choose from — a filter with a single option
                isn't a filter. */}
            {availableSources.length > 1 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Source</div>
                <div className="flex flex-wrap gap-1.5">
                  {availableSources.map((id) => (
                    <FilterPill
                      key={id}
                      active={activeSources.includes(id)}
                      onClick={() => toggleSource(id)}
                    >
                      {SOURCE_LABELS[id]?.label || id}
                    </FilterPill>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Body style</div>
              <div className="flex flex-wrap gap-1.5">
                <FilterPill active={bodyStyle === ''} onClick={() => setBodyStyle('')}>Any</FilterPill>
                {BODY_STYLES.map((b) => (
                  <FilterPill key={b} active={bodyStyle === b} onClick={() => setBodyStyle(bodyStyle === b ? '' : b)}>
                    {b}
                  </FilterPill>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Sort by</div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md text-xs outline-none focus:ring-2 focus:ring-blue-500"
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center justify-between" style={{ color: 'var(--color-muted)' }}>
                <span>Year</span>
                <span style={{ color: 'var(--color-text)', opacity: 0.7 }}>
                  {yearRange[0] === EARLIEST_YEAR && yearRange[1] === LATEST_YEAR
                    ? 'Any'
                    : `${yearRange[0]} – ${yearRange[1]}`}
                </span>
              </div>
              {/* Two selects rather than a dual-thumb slider: year is a value
                  people know exactly ("2019 or newer"), and picking it from a
                  list beats hunting for it by dragging. */}
              <div className="flex items-center gap-1.5">
                <select
                  value={yearRange[0]}
                  onChange={(e) => {
                    const min = Number(e.target.value);
                    setYearRange(([, max]) => [min, Math.max(min, max)]);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-md text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  aria-label="Earliest year"
                >
                  {YEAR_CHOICES.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <span className="text-xs" style={{ color: 'var(--color-muted)' }}>to</span>
                <select
                  value={yearRange[1]}
                  onChange={(e) => {
                    const max = Number(e.target.value);
                    setYearRange(([min]) => [Math.min(min, max), max]);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-md text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  aria-label="Latest year"
                >
                  {YEAR_CHOICES.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label
                className="flex items-center gap-2 cursor-pointer text-xs font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                <input
                  type="checkbox"
                  checked={cpoOnly}
                  onChange={(e) => setCpoOnly(e.target.checked)}
                  className="rounded"
                  style={{ accentColor: 'var(--color-accent)' }}
                />
                Certified pre-owned only
              </label>
              <div className="text-[10px] mt-1 ml-6" style={{ color: 'var(--color-muted)', opacity: 0.7 }}>
                Manufacturer-backed warranty and inspection.
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center justify-between" style={{ color: 'var(--color-muted)' }}>
                <span>Price</span>
                <span style={{ color: 'var(--color-text)', opacity: 0.7 }}>
                  {formatPrice(priceRange[0])} – {priceRange[1] >= PRICE_CEILING ? 'Any' : formatPrice(priceRange[1])}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={PRICE_CEILING}
                step={5000}
                value={priceRange[1]}
                onChange={(e) => setPriceRange([priceRange[0], Number(e.target.value)])}
                className="w-full"
                aria-label="Maximum price"
              />
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center justify-between" style={{ color: 'var(--color-muted)' }}>
                <span>Mileage</span>
                <span style={{ color: 'var(--color-text)', opacity: 0.7 }}>
                  {mileageRange[1] >= MILEAGE_CEILING ? 'Any' : `up to ${mileageRange[1].toLocaleString()} mi`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={MILEAGE_CEILING}
                step={5000}
                value={mileageRange[1]}
                onChange={(e) => setMileageRange([mileageRange[0], Number(e.target.value)])}
                className="w-full"
                aria-label="Maximum mileage"
              />
            </div>

            <div className="pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
              <div className="text-xs" style={{ color: 'var(--color-muted)' }}>
                {viewingFavorites ? (
                  <>Showing <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{displayed.length}</span> saved</>
                ) : (
                  <>
                    Showing <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{displayed.length}</span>
                    {Number.isFinite(total) && total > displayed.length ? ` of ${total.toLocaleString()} matches` : ' listings'}
                  </>
                )}
              </div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--color-muted)', opacity: 0.6 }}>
                {viewingFavorites ? 'Saved on this device' : 'Live dealer inventory · Auto.dev'}
              </div>
            </div>
          </div>
        </aside>

        {/* Map + cards stack */}
        <div className="flex-1 flex flex-col overflow-hidden" ref={columnRef}>
          <div
            className="flex-shrink-0 relative"
            style={{
              // Driven directly by the wheel gesture, so no CSS transition —
              // an easing curve here would lag the cursor and feel rubbery.
              height: `${(mapFrac * 100).toFixed(2)}%`,
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <MapContainer
              center={US_CENTER}
              zoom={4}
              minZoom={3}
              maxZoom={14}
              scrollWheelZoom
              zoomAnimation
              style={{ height: '100%', width: '100%', background: MAP_THEME[tileTheme].background }}
            >
              {/* CARTO ships matched light/dark basemaps. `key` forces a
                  remount on theme change: TileLayer does support url updates,
                  but remounting also clears the cached tiles of the old
                  palette, which otherwise linger until they're panned out of
                  view. */}
              <TileLayer
                key={tileTheme}
                attribution='&copy; OpenStreetMap &copy; CARTO'
                url={MAP_THEME[tileTheme].url}
                subdomains="abcd"
                maxZoom={19}
              />
              <MapFocus listings={mappable} origin={origin} />
              <MapResizer trigger={mapFrac} />
              {mappable.map((l) => (
                <Marker
                  key={l.vin}
                  position={[l.dealer.lat, l.dealer.lng]}
                  icon={listingPin({ hovered: hoveredVin === l.vin, price: l.price, source: l.dealer.source, theme: tileTheme })}
                  eventHandlers={{
                    mouseover: () => handlePinHover(l.vin),
                    mouseout:  () => setHoveredVin((v) => (v === l.vin ? null : v)),
                    click:     () => onAnalyzeListing?.(l),
                  }}
                />
              ))}
            </MapContainer>
          </div>

          <div className="flex-1 overflow-y-auto p-4" ref={gridRef}>
            {error ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-2">
                <AlertCircle size={22} style={{ color: notConfigured ? 'var(--color-muted)' : '#ef4444' }} />
                <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                  {notConfigured ? 'Listings aren’t connected yet' : 'Couldn’t load listings'}
                </div>
                <div className="text-xs max-w-md" style={{ color: 'var(--color-muted)' }}>{error.message}</div>
                {!notConfigured && (
                  <button
                    onClick={() => runSearch(serverFilters, 1)}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all hover:opacity-80"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  >
                    <RefreshCw size={12} />
                    Try again
                  </button>
                )}
              </div>
            ) : loading ? (
              <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {/* Skeletons rather than a spinner — the grid keeps its shape,
                    so results don't shove the page around when they land. */}
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-xl overflow-hidden animate-pulse"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                  >
                    <div style={{ aspectRatio: '16 / 10', background: 'rgba(100,116,139,0.15)' }} />
                    <div className="p-3 space-y-2">
                      <div style={{ height: 10, width: '70%', background: 'rgba(100,116,139,0.2)', borderRadius: 4 }} />
                      <div style={{ height: 8, width: '45%', background: 'rgba(100,116,139,0.15)', borderRadius: 4 }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : displayed.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                {viewingFavorites ? (
                  <>
                    <Heart size={22} style={{ color: 'var(--color-muted)', opacity: 0.5 }} />
                    <div className="text-sm font-semibold mt-2" style={{ color: 'var(--color-text)' }}>No saved listings yet</div>
                    <div className="text-xs mt-1 max-w-sm" style={{ color: 'var(--color-muted)' }}>
                      Tap the heart on any listing to save it here. Saved cars stay put across searches and reloads.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>No listings match your search</div>
                    <div className="text-xs mt-1 max-w-sm" style={{ color: 'var(--color-muted)' }}>
                      Try a broader make/model, widen the price, year, or mileage range, or increase the search radius.
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {displayed.map((l) => (
                    <ListingCard
                      key={l.vin}
                      listing={l}
                      hovered={hoveredVin === l.vin}
                      favorited={favorites.has(l.vin)}
                      onHover={() => setHoveredVin(l.vin)}
                      onLeave={() => setHoveredVin((v) => (v === l.vin ? null : v))}
                      onAnalyze={() => onAnalyzeListing?.(l)}
                      onFavorite={() => toggleFavorite(l)}
                      onPhotoResolved={handlePhotoResolved}
                      cardRefSetter={(node) => {
                        if (node) cardRefs.current.set(l.vin, node);
                        else cardRefs.current.delete(l.vin);
                      }}
                    />
                  ))}
                </div>

                {hasMore && (
                  <div className="flex justify-center mt-4">
                    <button
                      onClick={() => runSearch(serverFilters, page + 1, { append: true })}
                      disabled={loadingMore}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold transition-all hover:opacity-80"
                      style={{
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text)',
                        opacity: loadingMore ? 0.6 : 1,
                      }}
                    >
                      {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
