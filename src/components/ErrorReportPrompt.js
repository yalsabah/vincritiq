// "VinCritiq quit unexpectedly — send a report?"
//
// Modeled on the macOS crash reporter: it appears after the fact, it's
// dismissible, and nothing is transmitted until the user says so. Two
// deliberate choices follow from that:
//
//   - Opt-in per incident. No silent telemetry. The report is assembled
//     locally and discarded on "Don't Send".
//   - The full payload is inspectable before sending. A user who can't see
//     what's leaving their machine is right not to trust the button, and the
//     stack is the part people actually worry about.
//
// Presented as a bottom-corner card rather than a modal: the error has usually
// already happened and the app is still usable, so blocking the whole screen
// would be a bigger interruption than the bug.

import React, { useState } from 'react';
import { AlertTriangle, X, Loader2, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { submitErrorReport, setOptedOut } from '../utils/errorReporter';

export default function ErrorReportPrompt({ report, onDismiss }) {
  const { user } = useAuth() || {};
  const [comment, setComment] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(null);
  const [dontAsk, setDontAsk] = useState(false);

  if (!report) return null;

  const close = () => {
    if (dontAsk) setOptedOut(true);
    onDismiss?.();
  };

  const send = async () => {
    setSending(true);
    setFailed(null);
    try {
      await submitErrorReport(report, {
        comment,
        userId: user?.uid || null,
        email: user?.email || null,
      });
      setSent(true);
      // Leave the confirmation up briefly so the user sees it landed, then
      // get out of the way on its own.
      setTimeout(close, 1400);
    } catch (err) {
      // A failure here must not re-enter the reporter — that's how you get an
      // error-reporting loop. Just tell the user plainly.
      // eslint-disable-next-line no-console
      console.error('[errorReport] send failed', err);
      setFailed(
        err?.code === 'permission-denied'
          ? 'Blocked by security rules — the errorReports rule may not be deployed yet.'
          : 'Could not send the report. Your work is unaffected.',
      );
      setSending(false);
    }
  };

  return (
    <div
      className="fixed z-[100000] safe-bottom"
      style={{ bottom: 16, right: 16, left: 16, maxWidth: 400, marginLeft: 'auto' }}
      role="dialog"
      aria-live="polite"
      aria-label="Send error report"
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.30)',
        }}
      >
        <div className="p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {sent ? 'Report sent — thank you' : 'VinCritiq hit an unexpected problem'}
              </div>
              {!sent && (
                <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-muted)' }}>
                  Sending the details helps get it fixed. Nothing is sent unless you choose to.
                </div>
              )}
            </div>
            <button
              onClick={close}
              aria-label="Dismiss"
              className="flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center hover:opacity-70"
              style={{ color: 'var(--color-muted)' }}
            >
              <X size={13} />
            </button>
          </div>

          {sent ? (
            <div className="flex items-center gap-1.5 mt-3 text-xs font-medium" style={{ color: '#16a34a' }}>
              <Check size={13} />
              Sent to the developer
            </div>
          ) : (
            <>
              <div
                className="mt-3 px-2.5 py-2 rounded-md text-[11px] font-mono break-words"
                style={{ background: 'var(--color-bg)', color: 'var(--color-muted)' }}
              >
                {report.message.slice(0, 180)}
              </div>

              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What were you doing when this happened? (optional)"
                rows={2}
                className="w-full mt-2 px-2.5 py-2 rounded-md text-xs outline-none resize-none focus:ring-2 focus:ring-blue-500"
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}
              />

              <button
                onClick={() => setShowDetails((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium hover:opacity-80"
                style={{ color: 'var(--color-muted)' }}
                aria-expanded={showDetails}
              >
                {showDetails ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {showDetails ? 'Hide' : 'Show'} what will be sent
              </button>

              {showDetails && (
                <pre
                  className="mt-2 p-2 rounded-md text-[10px] overflow-auto"
                  style={{
                    background: 'var(--color-bg)',
                    color: 'var(--color-muted)',
                    maxHeight: 160,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {JSON.stringify(
                    {
                      ...report,
                      comment: comment || '(none)',
                      signedInAs: user?.email || '(not signed in)',
                    },
                    null,
                    1,
                  )}
                </pre>
              )}

              {failed && (
                <div className="mt-2 text-[11px]" style={{ color: '#dc2626' }}>{failed}</div>
              )}

              <label
                className="flex items-center gap-1.5 mt-3 text-[11px] cursor-pointer"
                style={{ color: 'var(--color-muted)' }}
              >
                <input
                  type="checkbox"
                  checked={dontAsk}
                  onChange={(e) => setDontAsk(e.target.checked)}
                  style={{ accentColor: 'var(--color-accent)' }}
                />
                Don't ask again on this device
              </label>

              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={send}
                  disabled={sending}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold text-white transition-all hover:opacity-90"
                  style={{ background: 'var(--color-accent)', opacity: sending ? 0.6 : 1 }}
                >
                  {sending && <Loader2 size={12} className="animate-spin" />}
                  {sending ? 'Sending…' : 'Send Report'}
                </button>
                <button
                  onClick={close}
                  className="px-3 py-2 rounded-md text-xs font-semibold transition-all hover:opacity-80"
                  style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  Don't Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
