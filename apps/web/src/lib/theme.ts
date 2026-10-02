import type { ThemePref } from '@/api/types';

const KEY = 'bastion.theme';

/** Light is the default for everyone; dark is an opt-in stored per user (18.1). */
export const cachedTheme = (): ThemePref | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
};

export function applyTheme(theme: ThemePref): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode: the user's saved preference still comes from /me
  }
}
