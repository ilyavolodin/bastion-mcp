import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, cachedTheme } from './theme';

describe('theme (18.1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.dataset.theme = 'light';
  });

  it('knows nothing until a theme was applied', () => {
    expect(cachedTheme()).toBeNull();
  });

  it('applies the theme to the document and remembers it in this browser', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(cachedTheme()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(cachedTheme()).toBe('light');
  });

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem('bastion.theme', 'sepia');
    expect(cachedTheme()).toBeNull();
  });

  it('works without storage: nothing is remembered, nothing throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(cachedTheme()).toBeNull();
    expect(() => applyTheme('dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
