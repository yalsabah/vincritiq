import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

const ThemeContext = createContext(null);

export const useTheme = () => useContext(ThemeContext);

// Theme is sourced in this order of priority:
//   1. The signed-in user's preference (userDoc.preferences.theme) — applied
//      by AppInner via setDark() once auth resolves. Per-user, survives
//      sign-out → sign-in cycles even on a fresh device.
//   2. localStorage 'carbot-theme' — survives page reloads when not signed in.
//   3. OS-level prefers-color-scheme.
//
// We write to localStorage on every change so the unauthenticated path
// behaves correctly. Writing to Firestore is the responsibility of whoever
// has access to the auth context (AppInner).
export function ThemeProvider({ children }) {
  const [dark, setDarkState] = useState(() => {
    const saved = localStorage.getItem('carbot-theme');
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Track whether the dark class has changed between renders. Only when
  // it actually flips do we want to enable the smoothing transition —
  // otherwise the very first paint also gets the transition class, which
  // (harmlessly) animates from no value to current value but is wasted
  // work.
  const prevDarkRef = useRef(null);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    localStorage.setItem('carbot-theme', dark ? 'dark' : 'light');

    // Keep the mobile browser chrome in step with the app's own theme. The
    // static <meta name="theme-color"> tags in index.html key off
    // prefers-color-scheme, which is the OS setting — that's the right default
    // on first paint, but it's wrong the moment a user picks a theme that
    // differs from their OS. Overwriting the tag here makes the status bar and
    // address bar follow the app instead.
    const bg = dark ? '#111110' : '#f5f4ef';
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((tag) => tag.setAttribute('content', bg));

    // Only run the smoothing transition when this is a real toggle, not
    // the initial mount.
    if (prevDarkRef.current !== null && prevDarkRef.current !== dark) {
      root.classList.add('theme-transitioning');
      const t = setTimeout(() => root.classList.remove('theme-transitioning'), 280);
      prevDarkRef.current = dark;
      return () => clearTimeout(t);
    }
    prevDarkRef.current = dark;
  }, [dark]);

  // setDark is a stable setter so AppInner's useEffect can depend on it
  // without re-firing every render.
  const setDark = useCallback((value) => {
    setDarkState(typeof value === 'function' ? value : !!value);
  }, []);

  const toggle = useCallback(() => setDarkState((d) => !d), []);

  return (
    <ThemeContext.Provider value={{ dark, setDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
