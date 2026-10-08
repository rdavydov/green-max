import { useTheme, type ThemePreference } from './theme';

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  return <label className="theme-switcher">
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
    <span>Тема</span>
    <select aria-label="Тема оформления" value={theme} onChange={(event) => setTheme(event.target.value as ThemePreference)}>
      <option value="system">Системная</option>
      <option value="light">Светлая</option>
      <option value="green">Зелёная</option>
      <option value="dark">Тёмная</option>
    </select>
  </label>;
}
