// Vehicle Finder — the conversational agent modal.
//
// A lightweight chat surface where the user describes the car they want in
// plain English. The agent (utils/findAgent.js) interprets it and hands the
// resulting filters to the parent via onApplyFilters — the RESULTS render in
// the main Find grid + map behind the modal, exactly like a normal search.
// The modal itself never shows cards; it's just the conversation. Close it to
// browse the grid, or keep refining in place.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Send, Loader2, Search } from 'lucide-react';
import { interpretRequest, agentFiltersToPanelState, describeFilters } from '../utils/findAgent';

const EXAMPLES = [
  'Black 2023 Audi S5 under 50k miles, around $35k, in Arizona',
  'Reliable SUV under $25k with low mileage',
  'Certified pre-owned Toyota Tacoma, newer than 2021',
];

export default function FindAgentModal({
  open,
  onClose,
  onApplyFilters,
  searchTotal,
  searchLoading,
}) {
  // Conversation turns: { role:'user'|'agent', text, filters?, applied? }.
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Open/close animation. `entered` drives the grow-in; `exiting` drives the
  // shrink-into-the-toolbar-button on close. Both animate transform + opacity
  // with a transform-origin at the top-right (where the "Find for me" button
  // and the pill live) so the modal reads as being swallowed back into them.
  const [entered, setEntered] = useState(false);
  const [exiting, setExiting] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const CLOSE_MS = 240;
  // Phones show this as a bottom sheet, so its collapsed state slides DOWN;
  // desktop shrinks toward the top-right button. Different origins/transforms.
  const [isNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, busy, searchLoading, searchTotal]);

  // Grow in on open: mount collapsed, then flip `entered` next frame so the
  // transition runs from the shrunken state to full size.
  useEffect(() => {
    if (open) {
      setExiting(false);
      setEntered(false);
      const raf = requestAnimationFrame(() => setEntered(true));
      setTimeout(() => inputRef.current?.focus(), 160);
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  // Play the shrink-away animation, then actually unmount.
  const beginClose = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setExiting(false);
      onClose?.();
    }, CLOSE_MS);
  }, [onClose]);

  const send = useCallback(
    async (text) => {
      const message = String(text ?? input).trim();
      if (!message || busy) return;
      setInput('');

      const history = turns.map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        text: t.text,
      }));
      setTurns((prev) => [...prev, { role: 'user', text: message }]);
      setBusy(true);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { reply, filters, clarifying } = await interpretRequest(message, history, controller.signal);
        setTurns((prev) => [
          ...prev,
          { role: 'agent', text: reply, filters, applied: !clarifying && !!filters },
        ]);
        // Hand the filters to the panel — the grid behind updates itself.
        if (!clarifying && filters) {
          onApplyFilters?.(agentFiltersToPanelState(filters));
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setTurns((prev) => [
          ...prev,
          { role: 'agent', text: `Sorry — ${err?.message || 'something went wrong.'} Try rephrasing?` },
        ]);
      } finally {
        if (controller === abortRef.current) setBusy(false);
      }
    },
    [input, busy, turns, onApplyFilters],
  );

  if (!open) return null;

  const empty = turns.length === 0;
  // Index of the most recent agent turn that drove a grid search — only that
  // one shows the live "finding / N matches" status.
  let lastAppliedIdx = -1;
  turns.forEach((t, i) => {
    if (t.role === 'agent' && t.applied) lastAppliedIdx = i;
  });

  // Portal to <body>: the Find panel lives inside `.mode-track`, whose CSS
  // transform would otherwise capture this fixed modal and push it off-screen.
  return createPortal(
    <div
      className="fixed inset-0 z-[100000] flex items-end sm:items-center justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Vehicle Finder"
    >
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
          opacity: entered && !exiting ? 1 : 0,
          transition: `opacity ${CLOSE_MS}ms ease`,
        }}
        onClick={beginClose}
      />
      <div
        className="relative flex flex-col w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl overflow-hidden safe-bottom"
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          height: 'min(76vh, 620px)',
          // Grow from / shrink into the top-right (toolbar button + pill live
          // there). On phones the sheet rises from / drops to the bottom.
          transformOrigin: isNarrow ? 'bottom center' : 'top right',
          transform:
            entered && !exiting
              ? 'translate(0, 0) scale(1)'
              : isNarrow
                ? 'translateY(100%)'
                : 'translate(90px, -70px) scale(0.35)',
          opacity: entered && !exiting ? 1 : 0,
          transition: `transform ${CLOSE_MS}ms cubic-bezier(0.34, 1.16, 0.64, 1), opacity ${CLOSE_MS}ms ease`,
          willChange: 'transform, opacity',
        }}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-accent)' }}>
            <Sparkles size={14} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold leading-tight" style={{ color: 'var(--color-text)' }}>Vehicle Finder</div>
            <div className="text-[11px] leading-tight" style={{ color: 'var(--color-muted)' }}>Describe the car — I’ll filter the listings for you</div>
          </div>
          <button onClick={beginClose} aria-label="Close" className="w-7 h-7 rounded-lg inline-flex items-center justify-center hover:opacity-70" style={{ color: 'var(--color-muted)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-2">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'var(--color-accent)' }}>
                <Sparkles size={22} className="text-white" />
              </div>
              <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>What are you looking for?</div>
              <div className="text-xs mt-1 mb-4 max-w-xs" style={{ color: 'var(--color-muted)' }}>
                Make, budget, mileage, color, location — whatever matters. I’ll set the filters and the matches show up in the grid behind this.
              </div>
              <div className="w-full space-y-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => send(ex)}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs transition-all hover:opacity-80"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  >
                    “{ex}”
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) => (
              <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
                {t.role === 'user' ? (
                  <div className="max-w-[85%] px-3 py-2 rounded-2xl text-sm text-white" style={{ background: 'var(--color-accent)' }}>
                    {t.text}
                  </div>
                ) : (
                  <div className="w-full">
                    <div className="max-w-[92%] px-3 py-2 rounded-2xl text-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                      {t.text}
                    </div>
                    {t.filters && describeFilters(t.filters).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {describeFilters(t.filters).map((chip, j) => (
                          <span key={j} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}>
                            {chip}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.applied && (
                      <div className="flex items-center gap-1.5 mt-2 text-[11px]" style={{ color: 'var(--color-muted)' }}>
                        {i === lastAppliedIdx ? (
                          searchLoading ? (
                            <>
                              <Loader2 size={12} className="animate-spin" /> Finding your vehicle…
                            </>
                          ) : (
                            <>
                              <Search size={12} style={{ color: 'var(--color-accent)' }} />
                              {Number.isFinite(searchTotal)
                                ? `${searchTotal.toLocaleString()} match${searchTotal === 1 ? '' : 'es'} in the grid — close to browse`
                                : 'Results updated in the grid — close to browse'}
                            </>
                          )
                        ) : (
                          <>
                            <Search size={12} /> Search updated
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Composer */}
        <div className="flex-shrink-0 p-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={empty ? 'e.g. black 2023 Audi S5 under $40k in AZ' : 'Refine your search…'}
              className="flex-1 resize-none px-3 py-2 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)', maxHeight: 100 }}
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white transition-all"
              style={{ background: 'var(--color-accent)', opacity: busy || !input.trim() ? 0.5 : 1 }}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
