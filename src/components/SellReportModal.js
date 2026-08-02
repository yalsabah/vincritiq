import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Award,
  Tag,
  Users,
  Zap,
  Globe,
  Gavel,
  TrendingUp,
  AlertCircle,
  Wrench,
  Star,
  Store,
  Map as MapIcon,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import DealersMap from './DealersMap';
import { DEALER_CATALOG } from '../utils/dealerCatalog';

// Sell-mode report viewer. Schema is documented in claudeApi.js
// SELL_SYSTEM_PROMPT. Renders:
//   - Recommended channel + reasoning (hero)
//   - Price-by-channel grid (5 channels)
//   - Recommended improvements with ROI
//   - Red flags + mitigations
//   - Market context
//
// Designed to mirror the structure of ReportModal (the Buy version) so the
// modal feels consistent, but the content is entirely sell-focused.

const fmt = (n) => {
  if (n == null || n === '') return '—';
  if (typeof n === 'string') return n;
  return `$${Math.round(n).toLocaleString()}`;
};

const fmtRange = (low, high) => {
  if (low == null && high == null) return '—';
  if (low == null) return fmt(high);
  if (high == null) return fmt(low);
  if (low === high) return fmt(low);
  return `${fmt(low)} – ${fmt(high)}`;
};

const CHANNEL_META = {
  privateParty:      { label: 'Private Party',   icon: Users,  color: '#16a34a' },
  tradeIn:           { label: 'Dealer Trade-In', icon: Tag,    color: '#dc2626' },
  instantOffer:      { label: 'Instant Offer',   icon: Zap,    color: '#2563eb' },
  onlineMarketplace: { label: 'Online Listing',  icon: Globe,  color: '#9333ea' },
  auction:           { label: 'Auction',         icon: Gavel,  color: '#b7550c' },
};

const ROI_BADGE = {
  great:        { label: 'Great ROI',  color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  good:         { label: 'Good ROI',   color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
  'break-even': { label: 'Break Even', color: '#888882', bg: 'rgba(136,136,130,0.12)' },
  skip:         { label: 'Skip',       color: '#dc2626', bg: 'rgba(220,38,38,0.12)' },
};

const SEVERITY_COLOR = {
  high:     '#dc2626',
  moderate: '#b7550c',
  low:      '#888882',
};

function MetricCard({ m }) {
  const colors = { green: '#16a34a', orange: '#b7550c', red: '#dc2626', gray: 'var(--color-muted)' };
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
    >
      <div className="text-xl font-bold" style={{ color: colors[m.color] || colors.gray }}>
        {m.value}
      </div>
      <div
        className="text-xs font-semibold uppercase tracking-wider mt-1"
        style={{ color: 'var(--color-muted)' }}
      >
        {m.label}
      </div>
      {m.sub && (
        <div className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>
          {m.sub}
        </div>
      )}
    </div>
  );
}

function ChannelCard({ channelKey, data, isRecommended }) {
  const meta = CHANNEL_META[channelKey];
  if (!meta || !data) return null;
  const Icon = meta.icon;
  return (
    <div
      className="rounded-xl p-4 transition-all"
      style={{
        background: 'var(--color-bg)',
        border: isRecommended
          ? `2px solid ${meta.color}`
          : '1px solid var(--color-border)',
        boxShadow: isRecommended ? `0 0 0 3px ${meta.color}22` : 'none',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: `${meta.color}22` }}
          >
            <Icon size={14} style={{ color: meta.color }} />
          </div>
          <span className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>
            {meta.label}
          </span>
        </div>
        {isRecommended && (
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ background: meta.color, color: '#fff' }}
          >
            Recommended
          </span>
        )}
      </div>
      <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
        {fmtRange(data.low, data.high)}
      </div>
      {data.mid != null && (
        <div className="text-xs" style={{ color: 'var(--color-muted)' }}>
          Most likely: {fmt(data.mid)}
        </div>
      )}
      {data.daysToSell != null && (
        <div className="text-xs mt-1.5 flex items-center gap-1" style={{ color: 'var(--color-muted)' }}>
          <TrendingUp size={11} />
          ~{data.daysToSell} days to sell
        </div>
      )}
      {data.notes && (
        <div
          className="text-xs mt-2 pt-2"
          style={{ color: 'var(--color-muted)', borderTop: '1px solid var(--color-border)' }}
        >
          {data.notes}
        </div>
      )}
      {Array.isArray(data.vendors) && data.vendors.length > 0 && (
        <div className="mt-2 pt-2 space-y-0.5" style={{ borderTop: '1px solid var(--color-border)' }}>
          {data.vendors.map((v, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span style={{ color: 'var(--color-muted)' }}>{v.name}</span>
              <span style={{ color: 'var(--color-text)' }} className="font-mono">
                {fmt(v.estimate)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Card for one dealer in the "Where to Sell" panel. Merges the AI-generated
// per-vehicle recommendation (offer estimate, recommendationStrength) with
// the static catalog (policies, URL). Falls back to whichever is present.
function DealerCard({ rec }) {
  const slug = (rec.name || '').toLowerCase().replace(/[^a-z]/g, '');
  const catalog = DEALER_CATALOG.find(
    (d) => d.id === slug || (d.name || '').toLowerCase() === (rec.name || '').toLowerCase(),
  );
  const strength = rec.recommendationStrength;
  const strengthMeta = {
    top_pick:    { label: 'Top Pick',    color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
    good_option: { label: 'Good Option', color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
    fallback:    { label: 'Fallback',    color: '#b7550c', bg: 'rgba(183,85,12,0.12)' },
    avoid:       { label: 'Avoid',       color: '#dc2626', bg: 'rgba(220,38,38,0.12)' },
  };
  const badge = strengthMeta[strength];
  const inspectionLabel = rec.requiresInspection
    ? (rec.inspectionType === 'video'
        ? 'Video inspection'
        : rec.inspectionType === 'none'
        ? 'No inspection'
        : 'In-person inspection')
    : 'No inspection required';
  return (
    <div
      className="rounded-xl p-4 transition-all"
      style={{
        background: 'var(--color-bg)',
        border: badge ? `1.5px solid ${badge.color}55` : '1px solid var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>
            {rec.name}
          </div>
          {catalog?.locationCount && (
            <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>
              {catalog.locationCount}
            </div>
          )}
        </div>
        {badge && (
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full flex-shrink-0"
            style={{ background: badge.bg, color: badge.color }}
          >
            {badge.label}
          </span>
        )}
      </div>

      {rec.estimatedOffer != null && (
        <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
          ${Math.round(rec.estimatedOffer).toLocaleString()}
          {rec.offerVsPrivateParty != null && (
            <span className="text-xs ml-2 font-normal" style={{ color: 'var(--color-muted)' }}>
              ({rec.offerVsPrivateParty > 0 ? '+' : ''}{rec.offerVsPrivateParty}% vs private party)
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px]" style={{ color: 'var(--color-muted)' }}>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
          style={{
            background: rec.requiresInspection ? 'rgba(183,85,12,0.12)' : 'rgba(22,163,74,0.12)',
            color: rec.requiresInspection ? '#b7550c' : '#16a34a',
          }}
        >
          <CheckCircle2 size={10} /> {inspectionLabel}
        </span>
        {rec.speed && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
          >
            <TrendingUp size={10} /> {rec.speed}
          </span>
        )}
      </div>

      {rec.rationale && (
        <p className="text-xs mt-2.5 leading-relaxed" style={{ color: 'var(--color-muted)' }}>
          {rec.rationale}
        </p>
      )}

      {catalog?.sellUrl && (
        <a
          href={catalog.sellUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
          style={{ color: 'var(--color-accent)' }}
        >
          Start quote
          <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

export default function SellReportModal({ report, vehicleLabel, onClose }) {
  const [exiting, setExiting] = useState(false);
  // showMap is driven by an IntersectionObserver on the "Where to Sell"
  // section ref below — NOT by a button. When the user scrolls down to
  // that section, the modal narrows and the map slides in from the right.
  // Scrolling back up reverses it.
  const [showMap, setShowMap] = useState(false);
  // On a phone the side-by-side map narrows the report pane to ~54% of a
  // ~375px screen — the same one-word-per-line squeeze the buy modal had.
  // Below md the map never slides in; the report keeps the full width.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Effective flag used by the layout — the IntersectionObserver still tracks
  // scroll position, but on a phone that never widens the modal.
  const mapVisible = showMap && !isNarrow;
  const closeTimer = useRef(null);
  const scrollContainerRef = useRef(null);
  const whereToSellRef = useRef(null);

  const handleClose = () => {
    setExiting(true);
    closeTimer.current = setTimeout(onClose, 180);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open/close the map based on whether the "Where to Sell" section
  // is visible inside the modal's scroll viewport.
  //
  // - `root: scrollContainerRef.current` tells the observer to use the
  //   modal's inner scroller as the viewport (not the window), so it
  //   correctly fires when the user scrolls inside the modal.
  // - threshold 0.15 = open as soon as ~15% of the section is in view;
  //   reverses on scroll-out so closing the map feels natural too.
  // - Re-runs when the section ref attaches (showMap initial state ensures
  //   the section doesn't mount conditionally).
  useEffect(() => {
    if (!whereToSellRef.current || !scrollContainerRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowMap(entry.isIntersecting),
      {
        root: scrollContainerRef.current,
        threshold: 0.15,
      },
    );
    observer.observe(whereToSellRef.current);
    return () => observer.disconnect();
    // Re-bind if the report changes (different vehicle, re-render).
  }, [report]);

  if (!report) return null;
  const vehicle = report.vehicle || {};
  const prices = report.prices || {};
  const rec = report.recommendation || {};
  const improvements = Array.isArray(report.improvements) ? report.improvements : [];
  const redFlags = Array.isArray(report.redFlags) ? report.redFlags : [];
  const market = report.marketContext || {};
  const metrics = Array.isArray(report.metrics) ? report.metrics : [];
  const dealerRecs = Array.isArray(report.dealerRecommendations)
    ? report.dealerRecommendations
    : [];

  const channelOrder = ['privateParty', 'tradeIn', 'instantOffer', 'onlineMarketplace', 'auction'];

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${exiting ? 'modal-out' : 'modal-in'}`}
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      role="dialog"
      aria-modal="true"
    >
      {/* Two-pane wrapper. Grows wider when the map should be visible —
          the modal pane shrinks proportionally and the map pane slides in
          from the right. CSS transitions handle the slide; the showMap
          state is driven by an IntersectionObserver on the "Where to Sell"
          section, not by a button. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex gap-4 items-stretch transition-all duration-[450ms] ease-in-out"
        style={{
          width: mapVisible ? 'min(1700px, 96vw)' : 'min(1000px, 92vw)',
          height: '92vh',
        }}
      >
      <div
        className="relative rounded-2xl overflow-hidden shadow-2xl flex flex-col flex-shrink-0 transition-all duration-[450ms] ease-in-out"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          // Account for the 16px gap between modal and map panes — without
          // subtracting, the two children sum to 100% + gap and overflow
          // the wrapper, which can squeeze the map width and confuse the
          // Leaflet resize calculation. calc(% - 8px) splits the gap evenly.
          width: mapVisible ? 'calc(54% - 8px)' : '100%',
          height: '100%',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div>
            <h2 className="font-bold text-lg" style={{ color: 'var(--color-text)' }}>
              {vehicleLabel
                || `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim()
                || 'Sell Analysis'}
            </h2>
            <div className="text-xs" style={{ color: 'var(--color-muted)' }}>
              {vehicle.trim && <span>{vehicle.trim}</span>}
              {vehicle.mileage && <span> · {vehicle.mileage.toLocaleString()} miles</span>}
              {vehicle.condition && <span> · {vehicle.condition} condition</span>}
              {vehicle.vin && <span> · VIN: {vehicle.vin}</span>}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X size={18} style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Hero: recommendation */}
          {rec.bestChannel && CHANNEL_META[rec.bestChannel] && (
            <div
              className="rounded-2xl p-5"
              style={{
                background: 'var(--color-bg)',
                border: `2px solid ${CHANNEL_META[rec.bestChannel].color}`,
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <Award size={16} style={{ color: CHANNEL_META[rec.bestChannel].color }} />
                <span
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: CHANNEL_META[rec.bestChannel].color }}
                >
                  Recommended: {CHANNEL_META[rec.bestChannel].label}
                </span>
              </div>
              <div className="flex items-baseline gap-3 mb-3">
                <span
                  className="text-3xl font-bold"
                  style={{ color: 'var(--color-text)' }}
                >
                  {fmt(rec.expectedNetPrice)}
                </span>
                <span className="text-xs" style={{ color: 'var(--color-muted)' }}>
                  Expected net price
                </span>
              </div>
              {rec.reasoning && (
                <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>
                  {rec.reasoning}
                </p>
              )}
              {Array.isArray(rec.tradeoffs) && rec.tradeoffs.length > 0 && (
                <div className="mt-3 pt-3 space-y-1" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <div
                    className="text-[10px] font-bold uppercase tracking-wider mb-1"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Tradeoffs
                  </div>
                  {rec.tradeoffs.map((t, i) => (
                    <div key={i} className="text-xs flex gap-2" style={{ color: 'var(--color-muted)' }}>
                      <span>•</span>
                      <span>{t}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Key metrics row */}
          {metrics.length > 0 && (
            <div>
              <div
                className="text-xs font-bold uppercase tracking-wider mb-2"
                style={{ color: 'var(--color-muted)' }}
              >
                Key Metrics
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {metrics.slice(0, 4).map((m, i) => (
                  <MetricCard key={i} m={m} />
                ))}
              </div>
            </div>
          )}

          {/* Channels grid */}
          <div>
            <div
              className="text-xs font-bold uppercase tracking-wider mb-2"
              style={{ color: 'var(--color-muted)' }}
            >
              Price by Channel
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {channelOrder.map((key) =>
                prices[key] ? (
                  <ChannelCard
                    key={key}
                    channelKey={key}
                    data={prices[key]}
                    isRecommended={rec.bestChannel === key}
                  />
                ) : null,
              )}
            </div>
          </div>

          {/* Where to Sell — recommended dealer chains for THIS vehicle,
              with policies (inspection required?), per-vehicle offer estimate.
              The integrated dealer map is in the right-pane sibling — it
              auto-opens when this section scrolls into view (handled by the
              IntersectionObserver above). No button; the map is a hidden
              pane that slides in based on scroll position. */}
          {(dealerRecs.length > 0 || DEALER_CATALOG.length > 0) && (
            <div ref={whereToSellRef}>
              <div className="flex items-center gap-2 mb-2">
                <Store size={14} style={{ color: 'var(--color-muted)' }} />
                <div
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: 'var(--color-muted)' }}
                >
                  Where to Sell
                </div>
                {/* Subtle hint that the map slid in. Only visible once it has. */}
                <span
                  className="text-[10px] transition-opacity duration-300 ml-1"
                  style={{
                    opacity: mapVisible ? 0.7 : 0,
                    color: 'var(--color-accent)',
                  }}
                >
                  <MapIcon size={10} className="inline mr-0.5" />
                  Map open →
                </span>
              </div>

              {/* Dealer cards — prefer the AI-generated per-vehicle recs.
                  If the AI didn't produce any (older reports, schema gap),
                  fall back to the static catalog so the panel never empties. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(dealerRecs.length > 0
                  ? dealerRecs
                  : DEALER_CATALOG.slice(0, 6).map((d) => ({
                      name: d.name,
                      estimatedOffer: null,
                      offerVsPrivateParty: d.offerVsMarket ?? null,
                      requiresInspection: d.requiresInspection,
                      inspectionType: d.inspectionType,
                      speed: d.speed,
                      recommendationStrength: null,
                      rationale: d.blurb,
                    }))
                ).map((rec, i) => (
                  <DealerCard key={i} rec={rec} />
                ))}
              </div>
            </div>
          )}

          {/* Improvements */}
          {improvements.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Wrench size={14} style={{ color: 'var(--color-muted)' }} />
                <div
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: 'var(--color-muted)' }}
                >
                  Recommended Improvements
                </div>
              </div>
              <div className="space-y-2">
                {improvements.map((imp, i) => {
                  const badge = ROI_BADGE[imp.roi] || ROI_BADGE.good;
                  return (
                    <div
                      key={i}
                      className="rounded-lg p-3"
                      style={{
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex-1">
                          <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                            {imp.action}
                          </div>
                          {imp.category && (
                            <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>
                              {imp.category}
                            </div>
                          )}
                        </div>
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full flex-shrink-0"
                          style={{ background: badge.bg, color: badge.color }}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs mt-1.5" style={{ color: 'var(--color-muted)' }}>
                        {imp.estimatedCost != null && (
                          <span>Cost: <span className="font-mono" style={{ color: 'var(--color-text)' }}>{fmt(imp.estimatedCost)}</span></span>
                        )}
                        {imp.expectedValueIncrease != null && (
                          <span>+ Value: <span className="font-mono" style={{ color: '#16a34a' }}>{fmt(imp.expectedValueIncrease)}</span></span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Red flags */}
          {redFlags.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle size={14} style={{ color: '#dc2626' }} />
                <div
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: 'var(--color-muted)' }}
                >
                  Red Flags & Mitigations
                </div>
              </div>
              <div className="space-y-2">
                {redFlags.map((rf, i) => (
                  <div
                    key={i}
                    className="rounded-lg p-3"
                    style={{
                      background: 'var(--color-bg)',
                      border: `1px solid ${SEVERITY_COLOR[rf.severity] || '#888882'}33`,
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <div
                        className="w-1 rounded-full flex-shrink-0 self-stretch"
                        style={{ background: SEVERITY_COLOR[rf.severity] || '#888882' }}
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                          {rf.flag}
                        </div>
                        {rf.mitigation && (
                          <div className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>
                            <span style={{ color: '#16a34a', fontWeight: 600 }}>→ </span>
                            {rf.mitigation}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Market context */}
          {(market.demand || market.seasonalTrend || market.competitorListings != null) && (
            <div
              className="rounded-xl p-4"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Star size={14} style={{ color: 'var(--color-muted)' }} />
                <div
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: 'var(--color-muted)' }}
                >
                  Market Context
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                {market.demand && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Demand</div>
                    <div
                      className="font-semibold capitalize"
                      style={{
                        color:
                          market.demand === 'high' ? '#16a34a' :
                          market.demand === 'low' ? '#dc2626' :
                          'var(--color-text)',
                      }}
                    >
                      {market.demand}
                    </div>
                  </div>
                )}
                {market.competitorListings != null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Local listings</div>
                    <div className="font-semibold font-mono" style={{ color: 'var(--color-text)' }}>
                      {market.competitorListings}
                    </div>
                  </div>
                )}
                {market.averageDaysOnMarket != null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Avg days on market</div>
                    <div className="font-semibold font-mono" style={{ color: 'var(--color-text)' }}>
                      {market.averageDaysOnMarket}
                    </div>
                  </div>
                )}
                {market.seasonalTrend && (
                  <div className="col-span-full">
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Seasonal trend</div>
                    <div className="text-sm" style={{ color: 'var(--color-text)' }}>
                      {market.seasonalTrend}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Map pane — sibling of the modal inside the flex wrapper. Slides
          in/out via width + transform + opacity transitions when showMap
          flips. Leaflet is heavy to initialize, so we only MOUNT the map
          the first time showMap goes true. After that we keep it mounted
          (toggling visibility via styles) to preserve tile cache + user
          location so re-opening is instant. */}
      <MapPane open={mapVisible} />
      </div>
    </div>
  );
}

// Small wrapper that keeps the map mounted after first open, so subsequent
// scroll-toggles don't re-init Leaflet. Before first open it renders an
// empty pane (no Leaflet cost); first time `open` is true it mounts the
// map for real and never unmounts.
function MapPane({ open }) {
  const [hasOpened, setHasOpened] = React.useState(false);
  React.useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);
  return (
    <div
      className="rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 transition-all duration-[450ms] ease-in-out"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        // Match the modal pane's gap math (calc(% - 8px)) so the two
        // children plus the 16px gap exactly fill the wrapper width.
        width: open ? 'calc(46% - 8px)' : 0,
        height: '100%',
        opacity: open ? 1 : 0,
        transform: open ? 'translateX(0)' : 'translateX(40px)',
        pointerEvents: open ? 'auto' : 'none',
      }}
      aria-hidden={!open}
    >
      {hasOpened && (
        <div style={{ width: '100%', height: '100%' }}>
          <DealersMap height="100%" />
        </div>
      )}
    </div>
  );
}
