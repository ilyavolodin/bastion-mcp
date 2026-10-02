import { createHash } from 'node:crypto';
import {
  COLORS,
  FONT_MONO,
  FONT_SANS,
  FONT_WEIGHTS,
  GRADIENTS,
  RADII,
  SHADOWS,
  SPACING,
  type Theme,
} from './tokens';

/** localStorage key the SPA uses for the saved theme (apps/web/src/lib/theme.ts). */
export const THEME_STORAGE_KEY = 'bastion.theme';

export const fontUrl = (weight: number): string => `/assets/fonts/poppins-latin-${weight}.woff2`;

const themeVars = (theme: Theme): string =>
  [
    ...Object.entries(COLORS).map(([name, value]) => `--${name}:${value[theme]}`),
    ...Object.entries(SHADOWS).map(([name, value]) => `--${name}:${value[theme]}`),
  ].join(';');

const fixedVars = (): string =>
  [
    ...Object.entries(GRADIENTS).map(([name, value]) => `--${name}:${value}`),
    ...Object.entries(RADII).map(([name, value]) => `--${name}:${value}`),
    ...Object.entries(SPACING).map(([name, value]) => `--${name}:${value}`),
    `--font-sans:${FONT_SANS}`,
    `--font-mono:${FONT_MONO}`,
  ].join(';');

const fontFaces = (): string =>
  FONT_WEIGHTS.map(
    (w) =>
      `@font-face{font-family:"Poppins";font-style:normal;font-weight:${w};font-display:swap;src:url(${fontUrl(w)}) format("woff2")}`,
  ).join('\n');

/** The component rules, written against the token variables only. */
const RULES = `
*,*::before,*::after{box-sizing:border-box}
html{background:var(--canvas);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--canvas);color:var(--ink);font-family:var(--font-sans);font-size:14px;line-height:22px;font-weight:400;-webkit-font-smoothing:antialiased}
a{color:var(--sky-ink);text-underline-offset:2px}
a:hover{color:var(--ink)}
:focus{outline:2px solid transparent}
:focus-visible{outline:2px solid transparent;box-shadow:var(--focus-ring)}
::selection{background:var(--tangerine-soft)}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:var(--space-4);top:var(--space-4);transform:translateY(-200%);padding:var(--space-2) var(--space-4);background:var(--surface);color:var(--ink);border-radius:var(--radius-md);box-shadow:var(--shadow-float);z-index:10;text-decoration:none;font-weight:500}
.skip:focus{transform:none}

.shell{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-6);padding:var(--space-8) var(--space-4)}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none}
.brand:hover{color:var(--ink)}
.brand svg{flex:none;color:var(--tangerine-ink)}
.brand span{font-size:18px;line-height:24px;font-weight:600;letter-spacing:-.01em}
.card{position:relative;width:100%;max-width:440px;overflow:hidden;background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-card);padding:var(--space-8)}
.card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--gradient-spectrum)}
.card.wide{max-width:560px}
@media (max-width:480px){.shell{padding:var(--space-6) var(--space-4)}.card{padding:var(--space-6) var(--space-5)}}
h1{margin:0 0 var(--space-1);font-size:28px;line-height:36px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{margin:var(--space-6) 0 var(--space-2);font-size:17px;line-height:24px;font-weight:600}
p{margin:0 0 var(--space-4)}
.lede{margin:0 0 var(--space-5);color:var(--ink-muted)}
.muted{color:var(--ink-muted)}
.caption{font-size:12px;line-height:16px;color:var(--ink-muted)}
.overline{display:block;margin:0 0 var(--space-2);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted)}
code,.mono{font-family:var(--font-mono);font-size:13px;overflow-wrap:anywhere}
strong{font-weight:600}
.foot{max-width:440px;text-align:center;font-size:12px;line-height:16px;color:var(--ink-muted)}

form{margin:0}
.field{display:flex;flex-direction:column;gap:6px;margin:0 0 var(--space-4)}
.field-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3)}
.field label,.field .label{font-size:12px;line-height:16px;font-weight:500;color:var(--ink-muted)}
.field .hint{font-size:12px;line-height:16px;color:var(--ink-muted)}
.field .error-text{font-size:12px;line-height:16px;color:var(--coral-ink)}
.field-head a{font-size:12px;line-height:16px;font-weight:500}
input[type=text],input[type=email],input[type=password],input[type=search]{width:100%;height:44px;padding:0 var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-md);background:var(--surface);color:var(--ink);font:inherit;font-size:14px}
input::placeholder{color:var(--ink-muted);opacity:1}
input[aria-invalid=true]{border-color:var(--coral-ink)}
input:disabled{opacity:.6;cursor:not-allowed}
.code-input::placeholder{text-transform:none;letter-spacing:0;font-size:14px;font-weight:400;font-family:var(--font-sans)}
.code-input{height:56px!important;text-align:center;text-transform:uppercase;letter-spacing:.2em;font-size:20px!important;font-weight:600;font-family:var(--font-mono)!important}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;height:44px;padding:0 18px;border:0;border-radius:var(--radius-md);font-family:inherit;font-size:14px;line-height:20px;font-weight:500;text-decoration:none;text-align:center;cursor:pointer;transition:filter .12s,background-color .12s}
.btn:hover{filter:brightness(1.03)}
.btn-primary,.btn-primary:hover{background:var(--gradient-tangerine);color:var(--on-bright);box-shadow:var(--glow-tangerine)}
.btn-primary:focus-visible{box-shadow:var(--focus-ring),var(--glow-tangerine)}
.btn-outline,.btn-outline:hover{background:var(--surface);color:var(--ink);border:1px solid var(--line-strong)}
.btn-soft,.btn-soft:hover{background:var(--tangerine-soft);color:var(--tangerine-ink)}
.btn-danger,.btn-danger:hover{background:var(--coral);color:var(--on-bright)}
.btn-outline:hover,.btn-soft:hover{background:var(--surface-sunken)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn svg{flex:none}
.stack{display:flex;flex-direction:column;gap:var(--space-3);margin:0 0 var(--space-4)}
.block{display:block}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-3);margin-top:var(--space-5)}
.actions .btn{flex:1 1 140px;height:auto;min-height:44px;padding-top:8px;padding-bottom:8px}
.link-button{display:inline;padding:0;border:0;background:none;color:var(--sky-ink);font:inherit;text-decoration:underline;cursor:pointer}
.link-button:hover{color:var(--ink)}

.alert{display:flex;gap:10px;align-items:flex-start;margin:0 0 var(--space-4);padding:var(--space-3) 14px;border-radius:var(--radius-md);font-size:14px;line-height:20px}
.alert svg{flex:none;margin-top:1px}
.alert-body{min-width:0}
.alert-title{display:block;font-weight:600}
.alert p{margin:0}
.alert p+p{margin-top:var(--space-1)}
.alert-error{background:var(--coral-soft);color:var(--coral-ink)}
.alert-info{background:var(--sky-soft);color:var(--sky-ink)}
.alert-success{background:var(--mint-soft);color:var(--mint-ink)}
.alert-warning{background:var(--tangerine-soft);color:var(--tangerine-ink)}
.live:empty{display:none}

.divider{display:flex;align-items:center;gap:var(--space-3);margin:var(--space-5) 0;font-size:12px;line-height:16px;color:var(--ink-muted)}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
.section{margin:0 0 var(--space-5)}

.client{display:flex;align-items:center;gap:var(--space-3);margin:0 0 var(--space-4)}
.client-name{font-size:17px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.avatar{flex:none;display:grid;place-items:center;width:48px;height:48px;overflow:hidden;border-radius:12px;background:var(--gradient-sunset);color:var(--on-bright);font-size:18px;font-weight:600}
.avatar img{width:100%;height:100%;object-fit:cover}
.chip{display:inline-flex;font-weight:500;max-width:100%;align-items:center;gap:6px;padding:2px 10px;border-radius:var(--radius-full);background:var(--surface-sunken);color:var(--ink);font-family:var(--font-mono);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.list{list-style:none;margin:0 0 var(--space-4);padding:0;display:flex;flex-direction:column;gap:var(--space-2)}
.list li{display:flex;gap:var(--space-3);align-items:flex-start;padding:10px var(--space-3);border-radius:var(--radius-md);background:var(--surface-sunken)}
.list li svg{flex:none;margin-top:2px;color:var(--mint-ink)}
.list .item-title{display:block;font-weight:500}
.list code.item-detail{margin-top:2px}
.list .item-detail{display:block;font-size:12px;line-height:16px;color:var(--ink-muted)}
.steps{margin:0 0 var(--space-4);padding-left:var(--space-5)}
.steps li{margin:0 0 var(--space-2);padding-left:var(--space-1)}
.code-block{margin:var(--space-2) 0 var(--space-4);padding:var(--space-3) 14px;border-radius:var(--radius-md);background:var(--surface-sunken);font-family:var(--font-mono);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.usercode{margin:0 0 var(--space-4);padding:var(--space-4);border-radius:var(--radius-md);background:var(--surface-sunken);font-family:var(--font-mono);font-size:28px;line-height:36px;font-weight:600;letter-spacing:.15em;text-align:center;overflow-wrap:anywhere}
.center{text-align:center}

@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
@media (forced-colors:active){.btn{border:1px solid ButtonText}.card{border:1px solid CanvasText}}
`;

export const buildPagesCss = (): string =>
  [
    fontFaces(),
    `:root{${themeVars('light')};${fixedVars()};color-scheme:light}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${themeVars('dark')};color-scheme:dark}}`,
    `:root[data-theme="dark"]{${themeVars('dark')};color-scheme:dark}`,
    RULES.trim(),
  ].join('\n');

/** Applies the theme the user saved in the console; without one the system preference decides (CSS above). */
export const PAGES_THEME_JS = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();\n`;

export const PAGES_CSS = buildPagesCss();

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 10);

/** Cache-busting query of the stylesheet and the theme script. */
export const PAGES_ASSET_VERSION = digest(PAGES_CSS + PAGES_THEME_JS);
export const PAGES_CSS_PATH = '/assets/pages.css';
export const PAGES_THEME_PATH = '/assets/pages-theme.js';
