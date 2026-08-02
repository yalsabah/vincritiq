import React, { useState, useRef, useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { recoverPendingJobs } from './utils/model3d';
import { verifyCheckoutSession } from './utils/stripeClient';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from './firebase/config';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { Loader2, Menu } from 'lucide-react';
import { ChatProvider, useChat } from './contexts/ChatContext';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import SessionInfoButton from './components/SessionInfoButton';
import AuthModal from './components/AuthModal';
import SettingsModal from './components/SettingsModal';
import UpgradeModal from './components/UpgradeModal';
import ErrorBoundary from './components/ErrorBoundary';
import ErrorReportPrompt from './components/ErrorReportPrompt';
import { installGlobalErrorHandlers, setErrorPromptHandler } from './utils/errorReporter';

function AppInner() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Drawer state for the phone layout. Desktop ignores this entirely — the
  // sidebar is a normal flex column there.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The drawer's open/closed transform is applied inline (below), and inline
  // styles can't be scoped to a breakpoint — so the breakpoint is tracked in
  // JS. Matches Tailwind's `md`.
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e) => setIsPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Set only when the sensor decides an error is genuinely unexpected — see
  // utils/errorReporter.js for what gets filtered out before this point.
  const [errorReport, setErrorReport] = useState(null);
  // Remember the sidebar state from before the report modal opened so we
  // can restore it on close. Auto-collapsing during side-by-side report
  // viewing maximizes the chat ↔ report split; restoring on close avoids
  // surprising users who deliberately had the sidebar open.
  const sidebarStateBeforeModalRef = useRef(null);
  const handleReportModalChange = (isOpen) => {
    if (isOpen) {
      if (sidebarStateBeforeModalRef.current === null) {
        sidebarStateBeforeModalRef.current = sidebarCollapsed;
        setSidebarCollapsed(true);
      }
    } else if (sidebarStateBeforeModalRef.current !== null) {
      setSidebarCollapsed(sidebarStateBeforeModalRef.current);
      sidebarStateBeforeModalRef.current = null;
    }
  };
  // rightSidebarCollapsed state retired — the right panel is now a
  // top-right "Session Info" dropdown (SessionInfoButton). The dropdown
  // owns its own open/close state internally.
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const { messages, activeMode } = useChat();
  // Find Me a Car takes over the full canvas — hide the left sidebar
  // and the top-right Session Info dropdown so the search surface owns
  // the screen. The slide animation runs via the sidebar's existing
  // width transition.
  const findModeActive = activeMode === 'find';

  // Switching modes is navigation, so the phone drawer has to close with it.
  // Without this, tapping a mode tab while the drawer is open left it sitting
  // over the new view — and in Find mode, where the sidebar collapses to zero
  // width, its contents ghosted through on top of the listings.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeMode]);

  // ChatInterface exposes a triggerCompact function via this ref so the
  // sidebar's "Compact Chat" button can invoke the same code path as typing
  // /compact in the input.
  const compactTriggerRef = useRef(null);
  const { user, userDoc, refreshUserDoc, signingIn } = useAuth();
  const { dark, setDark } = useTheme();

  // Sync theme from the signed-in user's preferences.
  //
  // The hard part of this is the race between two effects:
  //   (1) When userDoc lands, call setDark(saved value).
  //   (2) When `dark` changes, persist to Firestore.
  // Both effects run after the SAME render commit, in declaration order.
  // Effect (1)'s setDark queues a state update — `dark` itself doesn't
  // reflect the new value until the next render. So if effect (2) runs
  // immediately after, it sees the OLD `dark`, sees that it differs from
  // userDoc.preferences.theme, and writes the WRONG value back to Firestore
  // — overwriting the user's actual preference with whatever the page
  // happened to be showing at sign-in.
  //
  // Fix: gate effect (2) behind a "ready to persist" flag that flips ON
  // one tick AFTER effect (1) ran. By the time the flag is true, the
  // setDark from effect (1) has propagated to `dark`, so effect (2) reads
  // the correct value. The flag also resets whenever the uid changes so
  // a different user's sign-in can't inherit the previous user's gate.
  const appliedThemeForUidRef = useRef(null);
  const themeReadyForPersistRef = useRef(false);

  // Reset the persist gate when uid changes — covers sign-out → sign-in
  // with a different user.
  useEffect(() => {
    themeReadyForPersistRef.current = false;
    appliedThemeForUidRef.current = null;
  }, [user?.uid]);

  // Effect (1): apply the user's saved theme exactly once per uid.
  useEffect(() => {
    if (!user?.uid || !userDoc) return;
    if (appliedThemeForUidRef.current === user.uid) return;
    appliedThemeForUidRef.current = user.uid;
    const saved = userDoc?.preferences?.theme;
    if (saved === 'dark' || saved === 'light') {
      setDark(saved === 'dark');
    }
    // Defer enabling persistence until the setDark above has had a chance
    // to commit. setTimeout(0) yields to the next microtask, after which
    // any future `dark` change is necessarily a real user toggle.
    const t = setTimeout(() => {
      themeReadyForPersistRef.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, [user?.uid, userDoc, setDark]);

  // Effect (2): persist user-initiated theme changes back to Firestore.
  useEffect(() => {
    if (!user?.uid) return;
    if (!themeReadyForPersistRef.current) return;
    const pref = dark ? 'dark' : 'light';
    if (userDoc?.preferences?.theme === pref) return;
    updateDoc(doc(db, 'users', user.uid), {
      'preferences.theme': pref,
    }).catch(() => {});
  }, [dark, user?.uid, userDoc?.preferences?.theme]);

  // Global error sensor. Installed once, before anything else runs, so a
  // failure during startup is still caught. The handler only ever receives
  // errors that passed the benign / duplicate / rate-limit filters.
  useEffect(() => {
    const uninstall = installGlobalErrorHandlers();
    setErrorPromptHandler((report) => setErrorReport(report));
    return () => {
      setErrorPromptHandler(null);
      uninstall();
    };
  }, []);

  // On boot, recover any Tripo 3D jobs that were in-flight when the user
  // refreshed/closed the tab. This polls each saved task_id and persists
  // the result so we never waste a paid-for Tripo generation.
  useEffect(() => {
    recoverPendingJobs().catch(() => {});
  }, []);

  // Post-Stripe-checkout handler. Stripe redirects to /?stripe=success&session_id=…
  // We verify the session server-side, then write the new plan to the user's
  // Firestore doc (allowed by per-user rules — no Firebase Admin needed).
  // Strips the params from the URL afterward so a refresh doesn't re-run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stripeStatus = params.get('stripe');
    if (!stripeStatus) return;

    const cleanUrl = () => {
      params.delete('stripe');
      params.delete('session_id');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? '?' + next : ''}`);
    };

    if (stripeStatus !== 'success') {
      cleanUrl();
      return;
    }
    const sessionId = params.get('session_id');
    if (!sessionId || !user?.uid) {
      cleanUrl();
      return;
    }

    (async () => {
      const result = await verifyCheckoutSession({ sessionId, uid: user.uid });
      if (result.ok && result.planId) {
        try {
          await updateDoc(doc(db, 'users', user.uid), {
            plan: result.planId,
            stripeCustomerId: result.customerId || null,
            stripeSubscriptionId: result.subscriptionId || null,
            subscriptionStatus: 'active',
            subscriptionUpdatedAt: Date.now(),
          });
          await refreshUserDoc();
        } catch (err) {
          console.warn('[stripe] Firestore write after checkout failed', err);
        }
      } else {
        console.warn('[stripe] Checkout verification failed:', result.error);
      }
      cleanUrl();
    })();
  }, [user, refreshUserDoc]);

  return (
    <div className="flex app-shell overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      {errorReport && (
        <ErrorReportPrompt report={errorReport} onDismiss={() => setErrorReport(null)} />
      )}
      {/* On phones the sidebar becomes an overlay drawer instead of a column:
          at 320-430px wide there simply isn't room for a persistent sidebar
          plus a usable chat pane. It's rendered fixed + translated off-canvas,
          and the backdrop below dismisses it. */}
      <div
        className={[
          'flex-shrink-0',
          // The explicit width and overflow-hidden are load-bearing, not
          // cosmetic. `-translate-x-full` shifts by the element's OWN width,
          // and the sidebar collapses to width 0 in Find mode — so without a
          // fixed width the "closed" drawer translated by zero and its
          // children spilled over the listings. Clipping the wrapper keeps
          // that contained regardless of what the sidebar does internally.
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[280px] max-md:overflow-hidden',
          // Find mode owns the whole canvas on a phone; there's no drawer to
          // open into, so take it out of the tree entirely.
          findModeActive ? 'max-md:hidden' : '',
        ].join(' ')}
        // Inline rather than Tailwind translate utilities. Toggling between
        // `translate-x-0` and `-translate-x-full` leaves two equal-specificity
        // rules whose winner depends on Tailwind's emit order — in practice the
        // class flipped correctly while the computed transform stayed parked at
        // -100%, so the drawer never visually moved. Inline wins outright.
        style={
          isPhone
            ? {
                transform: mobileNavOpen ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 200ms ease',
              }
            : undefined
        }
      >
        <Sidebar
          // Inside the phone drawer the sidebar is always shown expanded —
          // an icon rail inside an overlay is a stub of a stub, and the
          // desktop collapsed preference shouldn't leak into it.
          collapsed={mobileNavOpen ? false : sidebarCollapsed}
          // On a phone the close button should dismiss the drawer outright,
          // the same as tapping the backdrop. Collapsing to a rail there just
          // leaves a sliver of sidebar covering the content. `mobileNavOpen`
          // is the reliable signal: it can only be true below md, since the
          // hamburger that sets it is md:hidden.
          onToggle={() => {
            if (mobileNavOpen) setMobileNavOpen(false);
            else setSidebarCollapsed((c) => !c);
          }}
          onOpenSettings={() => setShowSettings(true)}
          onOpenAuth={() => setShowAuth(true)}
          hidden={findModeActive}
          onNavigate={() => setMobileNavOpen(false)}
        />
      </div>

      {mobileNavOpen && !findModeActive && (
        <div
          className="md:hidden fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Hamburger — only exists on small screens, and not in Find mode where
          the search surface owns the whole canvas. */}
      {!findModeActive && !mobileNavOpen && (
        <button
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open menu"
          className="md:hidden fixed top-2 left-2 z-30 w-9 h-9 rounded-full inline-flex items-center justify-center safe-top"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        >
          <Menu size={17} />
        </button>
      )}

      <div className="flex-1 overflow-hidden">
        <ChatInterface
          onShowUpgrade={() => setShowUpgrade(true)}
          onShowAuth={() => setShowAuth(true)}
          compactTriggerRef={compactTriggerRef}
          onCompactingChange={setIsCompacting}
          onReportModalChange={handleReportModalChange}
        />
      </div>

      {!findModeActive && (
        <SessionInfoButton
          messages={messages}
          onPreviewImage={(url) => setPreviewImage(url)}
          onCompact={() => compactTriggerRef.current && compactTriggerRef.current()}
          isCompacting={isCompacting}
        />
      )}

      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-[80] flex items-center justify-center cursor-zoom-out"
          style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }}
          role="dialog"
          aria-label="Image preview"
        >
          <img
            src={previewImage}
            alt="Attached"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }}
          />
        </div>
      )}

      {/* Welcome-back loading screen — covers the ~1s window right after a
          fresh sign-in so the user sees a deliberate "logging you in" state
          instead of the auth modal jump-cutting straight to the populated
          chat. AuthContext flips signingIn back to false on a timer. */}
      {signingIn && (
        <div
          className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-3"
          style={{
            background: 'var(--color-bg)',
            animation: 'fadeIn 200ms ease',
          }}
          role="status"
          aria-live="polite"
        >
          <Loader2
            size={32}
            className="animate-spin"
            style={{ color: 'var(--color-accent)' }}
          />
          <div className="text-sm font-medium" style={{ color: 'var(--color-muted)' }}>
            Signing you in…
          </div>
        </div>
      )}

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onSignIn={() => { setShowUpgrade(false); setShowAuth(true); }}
        />
      )}
    </div>
  );
}

export default function App() {
  // ErrorBoundary wraps the entire provider stack so an uncaught throw
  // (Three.js GLB load failure, Firestore offline race, etc.) shows a
  // recovery card instead of a white screen.
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ChatProvider>
            <AppInner />
          </ChatProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
