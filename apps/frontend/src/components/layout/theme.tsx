'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { modeEmitter } from '@gitroom/frontend/components/layout/mode.component';

export type ThemePreference = 'light' | 'dark' | 'system';

const PREF_KEY = 'agencyos.theme';
const THEME_EVENT = 'agencyos:theme';

const systemTheme = (): 'light' | 'dark' =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const readCookie = (name: string) =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1];

/**
 * The person's choice. A choice made before system theme existed lives in the old `mode`
 * cookie, so it is honoured; otherwise AgencyOS follows the computer's setting.
 */
export const readPreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    /* storage can be blocked; fall through */
  }
  const legacy = readCookie('mode');
  return legacy === 'light' || legacy === 'dark' ? legacy : 'system';
};

/** Puts the theme on the page and keeps the cookie the rest of the app reads in step. */
const apply = (preference: ThemePreference) => {
  const resolved = preference === 'system' ? systemTheme() : preference;
  document.body.classList.remove('dark', 'light');
  document.body.classList.add(resolved);
  document.cookie = `mode=${resolved}; path=/; max-age=31536000; samesite=lax`;
  modeEmitter.emit('mode', resolved);
  return resolved;
};

export const useTheme = () => {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const sync = () => {
      const pref = readPreference();
      setPreferenceState(pref);
      setResolved(apply(pref));
    };
    sync();
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(PREF_KEY, next);
    } catch {
      /* the choice still applies for this visit */
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return { preference, resolved, setPreference };
};

/** Mounted once: applies the theme on load and follows the computer when the choice is "system". */
export const ThemeSync: FC = () => {
  const { preference, resolved } = useTheme();

  // In the desktop app the window buttons are drawn over the top bar, so they follow the theme.
  useEffect(() => {
    (
      window as unknown as {
        agencyos?: { setTitleBarTheme?: (dark: boolean) => Promise<boolean> };
      }
    ).agencyos?.setTitleBarTheme?.(resolved === 'dark');
  }, [resolved]);

  useEffect(() => {
    if (preference !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  return null;
};
