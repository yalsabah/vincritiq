// Crash / unexpected-error sensor.
//
// Watches for errors the app does NOT already handle, and offers the user a
// chance to send the details to the developer — the Apple "report this crash?"
// model. Reports land in Firestore `errorReports/{auto-id}`.
//
// Three problems this has to solve, in order of importance:
//
//   1. Only fire on the unfamiliar. An app this size throws expected errors
//      constantly — aborted fetches from a superseded search, a VIN VinAudit
//      doesn't stock, a Claude refusal, an offline blip. Prompting on those
//      trains the user to dismiss the dialog, which means the one real crash
//      gets dismissed too. Everything in KNOWN_BENIGN is filtered out, and
//      call sites can mark their own handled failures via `markHandled`.
//
//   2. Never nag. The same bug usually fires repeatedly — a broken render
//      loop can throw hundreds of times a second. Reports are fingerprinted
//      and rate-limited, per session and across sessions.
//
//   3. Never become the bug. Everything here is wrapped so a failure in the
//      reporter can't throw, recurse, or block the app. A reporter that
//      crashes while reporting a crash is worse than no reporter.

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

const SEEN_KEY = 'vincritiq.errorReports.seen';
const OPT_OUT_KEY = 'vincritiq.errorReports.optOut';

// Don't re-prompt for the same fingerprint within this window. Long enough
// that a recurring bug asks once a day, not once a minute.
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Hard ceiling per page load, regardless of fingerprint. A cascade of
// distinct errors is still one bad moment for the user, not six dialogs.
const MAX_PROMPTS_PER_SESSION = 2;

const MAX_STACK = 6000;
const MAX_COMPONENT_STACK = 4000;
const MAX_COMMENT = 1000;

// Errors we already handle and surface to the user ourselves. Matching any of
// these means "expected" — log it, never prompt.
//
// Each entry is [label, test]. The label is only for debugging why something
// was filtered; the test runs against the lowercased message.
const KNOWN_BENIGN = [
  // A superseded search/stream aborting is the normal path, not a fault.
  ['abort', (m, e) => e?.name === 'AbortError' || m.includes('aborted') || m.includes('abortsignal')],
  // Offline / transient network. The UI already shows a retry affordance.
  ['network', (m) => m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('network request failed')],
  // Listings + vehicle-data upstreams, all of which render their own error state.
  ['listings', (m) => m.includes('listings_') || m.includes('could not reach the listings service')],
  ['vinaudit', (m) => m.includes('not supported') && m.includes('vin')],
  // Claude paths that are surfaced in the transcript already.
  ['claude-refusal', (m) => m.includes('declined to analyze')],
  ['claude-overload', (m) => m.includes('overloaded') || m.includes('rate limit') || m.includes('429')],
  // Signed-out writes are a permissions design decision, not a defect.
  ['auth', (m) => m.includes('permission-denied') || m.includes('missing or insufficient permissions') || m.includes('auth/')],
  // Browser noise with no actionable cause. ResizeObserver in particular is a
  // spec quirk that fires on perfectly healthy layouts.
  ['resize-observer', (m) => m.includes('resizeobserver loop')],
  ['script-error', (m) => m === 'script error.' || m === 'script error'],
  // Third-party/extension frames — not our code, not our bug.
  ['extension', (m) => m.includes('chrome-extension://') || m.includes('moz-extension://') || m.includes('safari-extension://')],
  // Chunk load failures after a deploy: the fix is a reload, and the app
  // already recovers. Not worth a report each time we ship.
  ['stale-chunk', (m) => m.includes('loading chunk') || m.includes('dynamically imported module') || m.includes('importing a module script failed')],
];

const safe = (fn, fallback) => {
  try { return fn(); } catch { return fallback; }
};

/** Is this an error we already expect and handle? */
export function isKnownBenign(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return true; // nothing to act on
  return KNOWN_BENIGN.some(([, test]) => safe(() => test(message, error), false));
}

// Which benign rule matched — used only by the dev-mode console log so it's
// obvious why a given error didn't prompt.
function benignReason(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const hit = KNOWN_BENIGN.find(([, test]) => safe(() => test(message, error), false));
  return hit ? hit[0] : null;
}

// A stable-ish identity for an error so repeats can be collapsed. Built from
// the message with volatile parts (ids, numbers, urls, hashes) stripped, plus
// the first application stack frame.
export function fingerprint(error) {
  // Scrubbing order matters: the wider patterns have to run before the
  // digit sweep, or a VIN gets shredded into digits-and-letters and two
  // reports of the SAME bug on different vehicles look like different bugs —
  // which defeats the dedupe and re-prompts the user.
  const message = String(error?.message || error || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[a-hj-npr-z0-9]{17}\b/gi, '<vin>')
    // Both id rules emit the SAME token on purpose. An all-hex id ("abc123…")
    // hits the first rule and a mixed one ("zzz999…") hits the second; if they
    // produced different placeholders the identical bug would fingerprint two
    // ways depending on which characters the id happened to contain.
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b[a-z0-9_-]*\d[a-z0-9_-]*\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);

  const frame = safe(() => {
    const lines = String(error?.stack || '').split('\n').slice(1);
    const appFrame = lines.find((l) => !l.includes('node_modules')) || lines[0] || '';
    return appFrame.trim().replace(/:\d+:\d+/g, '').replace(/https?:\/\/[^/]+/g, '').slice(0, 120);
  }, '');

  return `${message}|${frame}`;
}

// ─── Throttling ───────────────────────────────────────────────────────────────

let promptsThisSession = 0;

const readSeen = () =>
  safe(() => JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}'), {}) || {};

function rememberSeen(fp) {
  safe(() => {
    const seen = readSeen();
    const now = Date.now();
    // Drop expired entries while we're here so the record can't grow forever.
    for (const [key, ts] of Object.entries(seen)) {
      if (now - ts > DEDUPE_WINDOW_MS) delete seen[key];
    }
    seen[fp] = now;
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  });
}

const seenRecently = (fp) =>
  safe(() => Date.now() - (readSeen()[fp] || 0) < DEDUPE_WINDOW_MS, false);

/** Has the user asked to stop being prompted? */
export const hasOptedOut = () =>
  safe(() => window.localStorage.getItem(OPT_OUT_KEY) === '1', false);

export const setOptedOut = (value) =>
  safe(() => window.localStorage.setItem(OPT_OUT_KEY, value ? '1' : '0'));

// ─── Capture ──────────────────────────────────────────────────────────────────

// The app subscribes here; the prompt UI is driven off this callback.
let onUnexpectedError = null;
export function setErrorPromptHandler(fn) {
  onUnexpectedError = typeof fn === 'function' ? fn : null;
}

/**
 * Build the payload we'd send. Exported so the prompt can show the user
 * exactly what leaves their machine before they agree to send it.
 */
export function buildReport(error, context = {}) {
  return {
    message: String(error?.message || error || 'Unknown error').slice(0, 1000),
    name: String(error?.name || 'Error').slice(0, 100),
    stack: String(error?.stack || '').slice(0, MAX_STACK),
    componentStack: String(context.componentStack || '').slice(0, MAX_COMPONENT_STACK),
    source: context.source || 'unknown', // 'render' | 'window' | 'promise' | 'manual'
    fingerprint: fingerprint(error),
    // Where in the app it happened — the single most useful triage field.
    mode: context.mode || null,
    sessionId: context.sessionId || null,
    url: safe(() => window.location.pathname + window.location.search, null),
    // Environment. Enough to reproduce, nothing that identifies a person
    // beyond the uid they're already signed in with.
    userAgent: safe(() => navigator.userAgent.slice(0, 400), null),
    viewport: safe(() => `${window.innerWidth}x${window.innerHeight}`, null),
    theme: safe(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'), null),
    appVersion: process.env.REACT_APP_VERSION || 'dev',
    occurredAt: new Date().toISOString(),
  };
}

/**
 * The sensor entry point. Call from anywhere an error escapes handling.
 *
 * Returns 'prompted' | 'benign' | 'duplicate' | 'throttled' | 'opted-out'
 * so callers (and tests) can see why nothing happened.
 */
export function captureError(error, context = {}) {
  return safe(() => {
    if (!error) return 'benign';

    if (isKnownBenign(error)) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.debug('[errorReporter] ignored (%s):', benignReason(error), error?.message || error);
      }
      return 'benign';
    }

    // Always log, whether or not we prompt — the console is still the fastest
    // path to a fix when the developer is the one hitting it.
    // eslint-disable-next-line no-console
    console.error('[errorReporter] unexpected error', error, context);

    if (hasOptedOut()) return 'opted-out';

    const fp = fingerprint(error);
    if (seenRecently(fp)) return 'duplicate';
    if (promptsThisSession >= MAX_PROMPTS_PER_SESSION) return 'throttled';

    promptsThisSession += 1;
    rememberSeen(fp);

    const report = buildReport(error, context);
    if (onUnexpectedError) onUnexpectedError(report);
    return 'prompted';
  }, 'benign');
}

/**
 * Escape hatch for call sites that handle a failure themselves and don't want
 * it treated as a crash — e.g. a fetch whose error is already rendered in the
 * UI. Logs in dev, does nothing else.
 */
export function markHandled(error, where) {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug('[errorReporter] handled at %s:', where, error?.message || error);
  }
}

// ─── Global listeners ─────────────────────────────────────────────────────────

let installed = false;

/** Wire up window-level capture. Safe to call more than once. */
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const onError = (event) => {
    // `event.error` carries the real Error when available; the string message
    // is all we get for cross-origin script failures (already filtered as
    // 'script error' noise).
    captureError(event?.error || event?.message, { source: 'window' });
  };
  const onRejection = (event) => {
    captureError(event?.reason, { source: 'promise' });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Send a report the user has explicitly approved.
 *
 * @param {object} report   From buildReport()
 * @param {object} extras   { comment, userId, email }
 * @returns {Promise<string>} Firestore doc id
 */
export async function submitErrorReport(report, { comment = '', userId = null, email = null } = {}) {
  const payload = {
    ...report,
    comment: String(comment || '').slice(0, MAX_COMMENT),
    userId: userId || null,
    // Only stored when the user is signed in — we never ask an anonymous
    // reporter for contact details.
    email: email || null,
    status: 'new', // triage state, so the developer can mark reports done
    createdAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, 'errorReports'), payload);
  return ref.id;
}

// Test seam — resets the per-session prompt counter.
export function __resetForTests() {
  promptsThisSession = 0;
}
