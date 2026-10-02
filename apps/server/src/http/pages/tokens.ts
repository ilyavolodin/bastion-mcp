/**
 * The Zest design tokens (docs/design/zest-tokens.json) as data. `css.ts` turns them into CSS variables; the test
 * `pages-css.test.ts` compares them with the JSON so the pages cannot drift from the design system.
 */
export type Theme = 'light' | 'dark';

export const COLORS: Record<string, Record<Theme, string>> = {
  canvas: { light: '#f4f5fa', dark: '#121214' },
  surface: { light: '#ffffff', dark: '#1c1c20' },
  'surface-sunken': { light: '#f4f5fa', dark: '#26262c' },
  line: { light: '#e8eaf1', dark: '#2e2e36' },
  'line-strong': { light: '#848aa3', dark: '#6c6e80' },
  ink: { light: '#171a3a', dark: '#f4f4f6' },
  'ink-muted': { light: '#5f6580', dark: '#a7a9b8' },
  'on-bright': { light: '#171a3a', dark: '#171a3a' },
  tangerine: { light: '#ff8a1f', dark: '#ff9433' },
  'tangerine-soft': { light: '#ffebd6', dark: '#3b2412' },
  'tangerine-ink': { light: '#b24700', dark: '#ffa855' },
  sun: { light: '#ffc23d', dark: '#ffc84f' },
  coral: { light: '#ff6b6b', dark: '#ff7a7a' },
  'coral-soft': { light: '#ffe4e4', dark: '#3a1b1d' },
  'coral-ink': { light: '#c42b2b', dark: '#ff9a9a' },
  mint: { light: '#2bc48a', dark: '#34d399' },
  'mint-soft': { light: '#dcf7eb', dark: '#0f2a20' },
  'mint-ink': { light: '#0a7a4d', dark: '#4ee0a3' },
  sky: { light: '#4c8dff', dark: '#5b9bff' },
  'sky-soft': { light: '#e3edff', dark: '#15233a' },
  'sky-ink': { light: '#1d5ad0', dark: '#8cb8ff' },
  teal: { light: '#1bb5a2', dark: '#2cc9b5' },
  berry: { light: '#e03fcb', dark: '#ea5ad8' },
  'berry-soft': { light: '#fbe4f7', dark: '#33152f' },
  'berry-ink': { light: '#a31b91', dark: '#f59ae9' },
};

export const SHADOWS: Record<string, Record<Theme, string>> = {
  'shadow-card': {
    light: '0 1px 2px #171a3a0a, 0 6px 20px -6px #171a3a14',
    dark: '0 1px 2px #00000066',
  },
  'shadow-float': {
    light: '0 10px 30px -8px #171a3a33',
    dark: '0 12px 32px -6px #000000cc',
  },
  'glow-tangerine': {
    light: '0 8px 20px -6px #ff7a1a8c',
    dark: '0 8px 22px -6px #ff7a1aa6',
  },
  'focus-ring': {
    light: '0 0 0 2px #ffffff, 0 0 0 4px #b24700',
    dark: '0 0 0 2px #1c1c20, 0 0 0 4px #ffa855',
  },
};

export const GRADIENTS: Record<string, string> = {
  'gradient-tangerine': 'linear-gradient(135deg, #ffc23d 0%, #ff8a1f 55%, #ff7a1a 100%)',
  'gradient-sunset': 'linear-gradient(135deg, #ff9a3c 0%, #ff5f7e 100%)',
  'gradient-spectrum':
    'linear-gradient(90deg, #ff8a1f 0%, #ffc23d 25%, #4c8dff 50%, #1bb5a2 75%, #e03fcb 100%)',
};

export const RADII: Record<string, string> = {
  'radius-sm': '6px',
  'radius-md': '10px',
  'radius-lg': '16px',
  'radius-xl': '20px',
  'radius-full': '9999px',
};

export const SPACING: Record<string, string> = {
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '20px',
  'space-6': '24px',
  'space-8': '32px',
};

export const FONT_SANS = '"Poppins", ui-sans-serif, system-ui, "Segoe UI", sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
