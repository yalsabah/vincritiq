import React, { useMemo } from 'react';
import {
  PanelRightClose,
  PanelRightOpen,
  FileText,
  Image as ImageIcon,
  Coins,
  Gauge,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { aggregateContextStats, CONTEXT_SOFT_BUDGET } from '../utils/contextStats';
import { formatUsd } from '../utils/pricing';

// Right-hand companion sidebar for the chat. Shows:
//   - All files attached across the current session (PDFs + image thumbnails)
//   - Token usage running totals
//   - "Reaching context limit" warning when input fill gets close to Claude's
//     200k window
//   - Compact Chat button (runs /compact without typing)
//
// Collapses to a thin rail by default on narrow viewports — driven by the
// `collapsed` prop owned by App.js so the layout flexbox knows the width.

function fmtNum(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function FilesPanel({ messages, onPreviewImage }) {
  // Walk every message in order and collect attachments. Source priority
  // mirrors MessageBubble:
  //   1. _attachments  (in-session, data URLs — fastest)
  //   2. imageUrls     (Firestore-persisted Storage URLs — survives refresh)
  //                    + PDF chips lifted from `files`
  //   3. files         (text-only fallback)
  // Without this triage, a refresh leaves the sidebar showing broken-image
  // placeholders even though the URLs are right there on the message.
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
            list.push({
              kind: 'pdf',
              name: f.replace(/^[^a-zA-Z0-9]*\s*/, ''),
              dataUrl: null,
            });
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
                // Open in a new tab so the user gets the browser's native PDF
                // viewer (search, zoom, page navigation) without leaving the
                // app. Data URLs work in Chrome/Firefox/Safari for PDF preview.
                const w = window.open();
                if (w) {
                  w.document.title = p.name;
                  w.document.body.style.margin = '0';
                  const iframe = w.document.createElement('iframe');
                  iframe.src = p.dataUrl;
                  iframe.style.cssText =
                    'border:0;width:100vw;height:100vh;display:block;';
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
                  title={
                    canOpen
                      ? `Open ${p.name} in a new tab`
                      : `${p.name} (re-attach to preview — original file not retained after refresh)`
                  }
                >
                  <FileText size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                  <span className="truncate flex-1">{p.name}</span>
                  {canOpen && (
                    <ExternalLink
                      size={11}
                      style={{ color: 'var(--color-muted)', flexShrink: 0 }}
                    />
                  )}
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
        <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
          Context window
        </span>
        <span className="font-mono" style={{ color: 'var(--color-muted)' }}>
          {pct}%
        </span>
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

// Sidebar widths in px. The wrapper always renders both states overlapped
// and animates `width` between them; the inner content fades with opacity so
// neither side flashes during the transition.
const COLLAPSED_W = 44;
const EXPANDED_W = 280;

export default function RightSidebar({
  messages,
  collapsed,
  onToggle,
  onPreviewImage,
  onCompact,
  isCompacting,
}) {
  const stats = useMemo(() => aggregateContextStats(messages), [messages]);

  return (
    <aside
      className="flex-shrink-0 overflow-hidden"
      style={{
        position: 'relative',
        width: collapsed ? COLLAPSED_W : EXPANDED_W,
        background: 'var(--color-surface)',
        borderLeft: '1px solid var(--color-border)',
        transition: 'width 220ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Collapsed-state handle. Stays in DOM and fades — that way clicking
          the chevron during a transition still works. pointer-events guards
          against accidental clicks through the layer that's fading out. */}
      <div
        className="absolute inset-y-0 left-0 flex flex-col items-center py-3"
        style={{
          width: COLLAPSED_W,
          opacity: collapsed ? 1 : 0,
          pointerEvents: collapsed ? 'auto' : 'none',
          transition: 'opacity 180ms ease',
        }}
      >
        <button
          onClick={onToggle}
          title="Show side panel"
          aria-label="Show side panel"
          className="p-1.5 rounded-lg hover:opacity-80 transition-opacity"
          style={{ color: 'var(--color-muted)' }}
        >
          <PanelRightOpen size={16} />
        </button>
        {stats.nearLimit && (
          <div
            title="Context near limit"
            className="mt-3 w-2 h-2 rounded-full"
            style={{ background: '#dc2626' }}
          />
        )}
      </div>

      {/* Expanded-state body. Fixed at EXPANDED_W so content never reflows
          mid-transition; instead the wrapper's overflow:hidden masks it as
          the wrapper's width animates. */}
      <div
        className="absolute inset-y-0 left-0 flex flex-col overflow-hidden"
        style={{
          width: EXPANDED_W,
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? 'none' : 'auto',
          transition: 'opacity 200ms ease 60ms',
        }}
      >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
          Session
        </div>
        <button
          onClick={onToggle}
          title="Hide side panel"
          aria-label="Hide side panel"
          className="p-1 rounded-md hover:opacity-80 transition-opacity"
          style={{ color: 'var(--color-muted)' }}
        >
          <PanelRightClose size={16} />
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

        {/* Context meter + compact */}
        <section>
          <ContextMeter stats={stats} onCompact={onCompact} isCompacting={isCompacting} />
        </section>

        {/* Files */}
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
    </aside>
  );
}
