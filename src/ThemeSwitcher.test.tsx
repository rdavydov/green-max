import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitcher } from './ThemeSwitcher';
import { THEME_STORAGE_KEY } from './theme';

let dark = false;
let mediaListeners: Set<EventListenerOrEventListenerObject>;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  dark = false;
  mediaListeners = new Set();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return dark; },
    addEventListener: (_name: string, callback: EventListenerOrEventListenerObject) => mediaListeners.add(callback),
    removeEventListener: (_name: string, callback: EventListenerOrEventListenerObject) => mediaListeners.delete(callback),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function systemColorScheme(value: boolean) {
  act(() => {
    dark = value;
    for (const callback of mediaListeners) {
      const event = new Event('change');
      if (typeof callback === 'function') callback(event);
      else callback.handleEvent(event);
    }
  });
}

describe('theme preference', () => {
  it('uses the system scheme by default and follows changes live', () => {
    render(<ThemeSwitcher />);
    expect(screen.getByRole('combobox', { name: 'Тема оформления' })).toHaveValue('system');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    systemColorScheme(true);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    systemColorScheme(false);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('loads a dark system scheme on first mount', () => {
    dark = true;
    render(<ThemeSwitcher />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it.each(['light', 'green', 'dark'])('persists an explicit %s theme across remounts', (theme) => {
    const view = render(<ThemeSwitcher />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Тема оформления' }), { target: { value: theme } });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
    expect(document.documentElement).toHaveAttribute('data-theme', theme);
    systemColorScheme(true);
    expect(document.documentElement).toHaveAttribute('data-theme', theme);
    view.unmount();
    render(<ThemeSwitcher />);
    expect(screen.getByRole('combobox', { name: 'Тема оформления' })).toHaveValue(theme);
    expect(document.documentElement).toHaveAttribute('data-theme', theme);
  });

  it('can return from an explicit theme to the current system scheme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'green');
    dark = true;
    render(<ThemeSwitcher />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Тема оформления' }), { target: { value: 'system' } });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('ignores an invalid stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'unknown-theme');
    render(<ThemeSwitcher />);
    expect(screen.getByRole('combobox', { name: 'Тема оформления' })).toHaveValue('system');
  });

  it('keeps the control usable when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    render(<ThemeSwitcher />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Тема оформления' }), { target: { value: 'dark' } });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('synchronizes a preference changed in another tab', () => {
    render(<ThemeSwitcher />);
    fireEvent(window, new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'green' }));
    expect(screen.getByRole('combobox', { name: 'Тема оформления' })).toHaveValue('green');
    expect(document.documentElement).toHaveAttribute('data-theme', 'green');
  });

  it('leaves one media listener under StrictMode and removes it on unmount', () => {
    const view = render(<StrictMode><ThemeSwitcher /></StrictMode>);
    expect(mediaListeners.size).toBe(1);
    view.unmount();
    expect(mediaListeners.size).toBe(0);
  });
});
