import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Info,
  FileText,
  Image as ImageIcon,
  Coins,
  Gauge,
  Sparkles,
  ExternalLink,
  X,
} from 'lucide-react';
import { aggregateContextStats, CONTEXT_SOFT_BUDGET } from '../utils/contextStats';
import { formatUsd } from '../utils/pricing';

// Compact session-info dropdown, replacing the always-visible right sidebar.
// Lives top-right of the app frame. Clicking the "Session Info" button
// toggles a positioned popover that shows the same content the sidebar
// used to show (tokens spent, context window, files attached, compact
// button). Click outside, hit Esc, or click the button again to close.
//
// Behaviour rationale:
//   - Sidebar was permanently using ~280px of screen real estate, which
//     was overkill for content the user looks at maybe once per session.
//   - Dropdown is hidden by default → wider main content area.
//   - The visual notch (red dot) on the button indicates near-limit
//     context without requiring the panel to be open.

function fmtNum(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function FilesPanel({ messages, onPreviewImage }) {
  // Same source-priority logic the legacy RightSidebar used: prefer
  // in-session _attachments, fall back to Firestore imageUrls, then to
  // the textual `files` chip list.
  const items = useMemo(() => {
    const collected = [];
    for (const m of messages) {
      let list;
      if (Array.isArray(m._attachments) && m._attachments.length > 0) {
        list = m._attachments;
      } else if (Array.isArray(m.imageUrls) && m.imageUrls.length > 0) {
        list = [];
        for (const f of m.files || []) {
          if (typeof f === 'string' && f.includes('📄')) {
            list.push({ kind: 'pdf', name: f.replace(/^[^a-zA-Z0-9]*\s*/, ''), dataUrl: null });
          }
        }
        for (const u of m.imageUrls) {
          list.push({ kind: 'image', name: u.name, dataUrl: u.url });
        }
      } else if (Array.isArray(m.files)) {
        list = m.files.map((f) => ({
          kind: typeof f === 'string' && f.includes('📄') ? 'pdf' : 'image',
          name: typeof f === 'string' ? f.replace(/^[^a-zA-Z0-9]*\s*/, '') : 'file',
          dataUrl: null,
        }));
      } else {
        list = [];
      }
      for (const a of list) collected.push({ ...a, msgId: m.id });
    }
    return collected;
  }, [messages]);

  const pdfs = items.filter((i) => i.kind === 'pdf');
  const imgs = items.filter((i) => i.kind === 'image');

  if (items.length === 0) {
    return (
      <div className="text-xs px-3 py-4 text-center" style={{ color: 'var(--color-muted)' }}>
        No files attached yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {imgs.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5 px-1" style={{ color: 'var(--color-muted)' }}>
            Images ({imgs.length})
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {imgs.map((img, i) => (
              <button
                key={i}
                onClick={() => img.dataUrl && onPreviewImage?.(img.dataUrl)}
                title={img.name}
                disabled={!img.dataUrl}
                className="rounded-md overflow-hidden transition-transform hover:scale-105 disabled:cursor-not-allowed"
                style={{
                  aspectRatio: '1 / 1',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg)',
                  padding: 0,
                  cursor: img.dataUrl ? 'zoom-in' : 'default',
                  opacity: img.dataUrl ? 1 : 0.6,
                }}
              >
                {img.dataUrl ? (
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <ImageIcon size={14} style={{ color: 'var(--color-muted)' }} />
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {pdfs.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5 px-1" style={{ color: 'var(--color-muted)' }}>
            Documents ({pdfs.length})
          </div>
          <div className="space-y-1">
            {pdfs.map((p, i) => {
              const canOpen = !!p.dataUrl;
              const handleOpen = () => {
                if (!canOpen) return;
                const w = window.open();
                if (w) {
                  w.document.title = p.name;
                  w.document.body.style.margin = '0';
                  const iframe = w.document.createElement('iframe');
                  iframe.src = p.dataUrl;
                  iframe.style.cssText = 'border:0;width:100vw;height:100vh;display:block;';
                  w.document.body.appendChild(iframe);
                }
              };
              return (
                <button
                  key={i}
                  type="button"
                  onClick={handleOpen}
                  disabled={!canOpen}
                  className="w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded-md text-left transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    opacity: canOpen ? 1 : 0.6,
                    cursor: canOpen ? 'pointer' : 'default',
                  }}
                  title={canOpen ? `Open ${p.name} in a new tab` : `${p.name} (re-attach to preview)`}
                >
                  <FileText size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                  <span className="truncate flex-1">{p.name}</span>
                  {canOpen && <ExternalLink size={11} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ContextMeter({ stats, onCompact, isCompacting }) {
  const pct = Math.round(stats.contextPct * 100);
  const barColor = stats.nearLimit ? '#dc2626' : pct > 40 ? '#b7550c' : '#16a34a';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold" style={{ color: 'var(--color-text)' }}>Context window</span>
        <span className="font-mono" style={{ color: 'var(--color-muted)' }}>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <div
          style={{
            width: `${Math.max(2, pct)}%`,
            height: '100%',
            background: barColor,
            transition: 'width 0.3s, background 0.3s',
          }}
        />
      </div>
      <div className="text-[10px] flex items-center justify-between" style={{ color: 'var(--color-muted)' }}>
        <span>Latest input: {fmtNum(stats.contextPct * CONTEXT_SOFT_BUDGET)} tok</span>
        <span>Soft limit: {fmtNum(CONTEXT_SOFT_BUDGET)}</span>
      </div>
      {stats.nearLimit && (
        <div
          className="rounded-lg p-2 text-[11px] leading-relaxed"
          style={{
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            color: '#dc2626',
          }}
        >
          Reaching context limit. Compact the chat to keep responses fast.
        </div>
      )}
      <button
        onClick={onCompact}
        disabled={isCompacting}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          background: stats.nearLimit ? 'var(--color-accent)' : 'var(--color-bg)',
          color: stats.nearLimit ? '#fff' : 'var(--color-text)',
          border: '1px solid var(--color-border)',
        }}
      >
        <Sparkles size={12} />
        {isCompacting ? 'Compacting…' : 'Compact Chat'}
      </button>
      <div className="text-[10px] text-center" style={{ color: 'var(--color-muted)' }}>
        Or send <code>/compact</code> in chat.
      </div>
    </div>
  );
}

export default function SessionInfoButton({ messages, onPreviewImage, onCompact, isCompacting }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const stats = useMemo(() => aggregateContextStats(messages), [messages]);

  // Close on Esc or outside-click. Both registered only while open so we
  // don't leak listeners on every keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      // z-index: 40 sits BELOW the modal layer (z-50) so the Session Info
      // button is naturally covered by any open modal's backdrop. The
      // user complained about it overlapping the Report Modal's X button
      // — modals already provide their own session-equivalent affordances
      // (close button, etc.), so hiding the floating button while one is
      // open is the right move. Stays above regular page chrome (chat,
      // sidebars are unzindexed = z:auto).
      style={{ position: 'fixed', top: 12, right: 12, zIndex: 40 }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
        style={{
          background: open ? 'var(--color-bg)' : 'var(--color-surface)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          boxShadow: open ? '0 4px 16px rgba(0,0,0,0.18)' : '0 1px 3px rgba(0,0,0,0.08)',
        }}
        title="Session info"
        aria-expanded={open}
      >
        <Info size={13} />
        Session Info
        {stats.nearLimit && (
          <span
            title="Context near limit"
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: '#dc2626',
              marginLeft: 2,
            }}
          />
        )}
      </button>

      {open && (
        <div
          className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 320,
            maxHeight: 'min(640px, calc(100vh - 80px))',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            animation: 'sessionInfoIn 180ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
              Session
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X size={14} style={{ color: 'var(--color-muted)' }} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
            {/* Tokens & cost */}
            <section>
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5"
                style={{ color: 'var(--color-muted)' }}
              >
                <Gauge size={11} /> Tokens spent
              </div>
              <div
                className="rounded-lg p-3 space-y-1"
                style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-muted)' }}>Input</span>
                  <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                    {fmtNum(stats.inputTokens)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-muted)' }}>Output</span>
                  <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                    {fmtNum(stats.outputTokens)}
                  </span>
                </div>
                <div
                  className="flex items-center justify-between text-xs pt-1.5 mt-1.5 font-semibold"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  <span style={{ color: 'var(--color-text)' }} className="flex items-center gap-1">
                    <Coins size={11} /> Cost
                  </span>
                  <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                    {formatUsd(stats.totalCostUsd)}
                  </span>
                </div>
              </div>
            </section>

            <section>
              <ContextMeter stats={stats} onCompact={onCompact} isCompacting={isCompacting} />
            </section>

            <section>
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-2"
                style={{ color: 'var(--color-muted)' }}
              >
                Attachments
              </div>
              <FilesPanel messages={messages} onPreviewImage={onPreviewImage} />
            </section>
          </div>
        </div>
      )}

      {/* Lightweight enter animation. Living here so the global stylesheet
          doesn't need a new keyframe. */}
      <style>{`
        @keyframes sessionInfoIn {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
