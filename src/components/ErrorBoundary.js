import React from 'react';
import { buildReport, isKnownBenign, submitErrorReport } from '../utils/errorReporter';

// Top-level error boundary. Catches uncaught render errors (including the
// ones Three.js throws when it can't load a GLB, which historically have
// taken down the entire app with a white screen).
//
// We deliberately render a minimal recovery UI rather than trying to
// reconstruct the page — anything more complex risks re-throwing. The
// "Reload" button is the escape hatch; the boundary state itself doesn't
// reset automatically because if we keep mounting the same broken
// children we'd just loop the same error.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, report: null, sendState: 'idle' };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface to the console so we can debug in prod. Cloudflare's logs
    // don't capture client-side errors, but this at least makes them
    // visible to anyone with DevTools open.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);

    // A render crash replaces the entire tree, so the app-level report prompt
    // is gone along with everything else — this boundary has to offer the
    // "send it to the developer" path itself. The payload is assembled here
    // but NOT sent; nothing leaves the machine until the user clicks.
    //
    // The benign filter still applies: a chunk-load failure after a deploy
    // takes down the tree too, and that isn't a bug worth reporting.
    let report = null;
    try {
      if (!isKnownBenign(error)) {
        report = buildReport(error, { source: 'render', componentStack: info?.componentStack });
      }
    } catch {
      // Never let report-building mask the original crash.
    }
    this.setState({ info, report });
  }

  sendReport = async () => {
    this.setState({ sendState: 'sending' });
    try {
      await submitErrorReport(this.state.report, {});
      this.setState({ sendState: 'sent' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary] report send failed', err);
      this.setState({ sendState: 'failed' });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const reload = () => window.location.reload();
    const reset = () => {
      try {
        // Best-effort: clear in-progress 3D generations and the active
        // theme override so a hot reload doesn't immediately re-crash.
        localStorage.removeItem('vincritiq_pending_3d_jobs_v1');
      } catch {}
      reload();
    };

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          background: '#0a0a0a',
          color: '#f0efe9',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica Neue, sans-serif',
          zIndex: 999999,
        }}
      >
        <div
          style={{
            maxWidth: 480,
            textAlign: 'center',
            padding: '32px 28px',
            borderRadius: 16,
            background: '#1c1c1a',
            border: '1px solid #2e2e2b',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 13, color: '#888882', marginBottom: 20, lineHeight: 1.5 }}>
            VinCritiq hit an unexpected error and couldn't continue. Your data
            is safe — reloading the page usually clears this.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              onClick={reload}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: '#2563eb',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              onClick={reset}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: 'transparent',
                color: '#f0efe9',
                fontWeight: 600,
                fontSize: 13,
                border: '1px solid #2e2e2b',
                cursor: 'pointer',
              }}
            >
              Reset & Reload
            </button>
          </div>

          {/* Opt-in crash report. Only offered when the error looks genuinely
              unexpected — see componentDidCatch. */}
          {this.state.report && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #2e2e2b' }}>
              {this.state.sendState === 'sent' ? (
                <div style={{ fontSize: 12, color: '#4ade80' }}>
                  Report sent — thank you. This helps get it fixed.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: '#888882', marginBottom: 10, lineHeight: 1.5 }}>
                    Send the technical details to the developer? Nothing is sent unless you choose to.
                  </div>
                  <button
                    onClick={this.sendReport}
                    disabled={this.state.sendState === 'sending'}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 8,
                      background: 'transparent',
                      color: '#93c5fd',
                      fontWeight: 600,
                      fontSize: 12,
                      border: '1px solid #1e3a8a',
                      cursor: this.state.sendState === 'sending' ? 'default' : 'pointer',
                      opacity: this.state.sendState === 'sending' ? 0.6 : 1,
                    }}
                  >
                    {this.state.sendState === 'sending' ? 'Sending…' : 'Send Report'}
                  </button>
                  {this.state.sendState === 'failed' && (
                    <div style={{ fontSize: 11, color: '#f87171', marginTop: 8 }}>
                      Couldn't send. The error above is unaffected — reloading still works.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {process.env.NODE_ENV !== 'production' && (
            <details style={{ marginTop: 20, textAlign: 'left' }}>
              <summary
                style={{ cursor: 'pointer', fontSize: 11, color: '#888882' }}
              >
                Stack (dev only)
              </summary>
              <pre
                style={{
                  fontSize: 10,
                  whiteSpace: 'pre-wrap',
                  marginTop: 8,
                  color: '#dc2626',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {String(this.state.error?.stack || this.state.error)}
                {this.state.info?.componentStack || ''}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
