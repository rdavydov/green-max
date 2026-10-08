import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'green' | 'dark';
export const THEME_STORAGE_KEY = 'green-max:theme';

const systemDarkQuery = '(prefers-color-scheme: dark)';

function isTheme(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'green' || value === 'dark';
}

function savedTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme() {
  const [theme, setPreference] = useState<ThemePreference>(savedTheme);

  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(systemDarkQuery) : null;
    function applyTheme() {
      const resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
    }
    applyTheme();
    if (theme === 'system') media?.addEventListener('change', applyTheme);
    return () => { media?.removeEventListener('change', applyTheme); };
  }, [theme]);

  useEffect(() => {
    function synchronize(event: StorageEvent) {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreference(isTheme(event.newValue) ? event.newValue : 'system');
      }
    }
    window.addEventListener('storage', synchronize);
    return () => window.removeEventListener('storage', synchronize);
  }, []);

  function setTheme(preference: ThemePreference) {
    setPreference(preference);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // A blocked or full browser store must not prevent changing the theme.
    }
  }

  return { theme, setTheme };
}
