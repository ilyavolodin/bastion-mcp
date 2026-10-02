/** The one layout every server-rendered page uses: brand header, centered Zest card, shared stylesheet. */
import { fontUrl, PAGES_ASSET_VERSION, PAGES_CSS_PATH, PAGES_THEME_PATH } from './css';
import { type Child, html, raw, type SafeHtml } from './html';

/** The Bastion shield mark (docs/design/Sidebar.dc.html), drawn with `currentColor`. */
export const BRAND_MARK = raw(
  '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" aria-hidden="true" focusable="false"><path d="M14 2.5 24 6.5v7.2c0 5.6-4.2 10.3-10 11.8C8.2 24 4 19.3 4 13.7V6.5L14 2.5z"/><path d="M9 11.5h10M9 15.5h10M14 7.5v13"/></svg>',
);

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#b24700" stroke-width="1.5" stroke-linejoin="miter"><path d="M14 2.5 24 6.5v7.2c0 5.6-4.2 10.3-10 11.8C8.2 24 4 19.3 4 13.7V6.5L14 2.5z"/><path d="M9 11.5h10M9 15.5h10M14 7.5v13"/></svg>',
  );

export type PageSpec = {
  /** The document title (without the product name) and, unless `heading` is given, the visible heading. */
  title: string;
  heading?: string;
  /** One sentence under the heading. */
  lede?: Child;
  body: Child;
  /** A wider card for pages with commands or tables. */
  wide?: boolean;
  /** Small print under the card. */
  footnote?: Child;
};

/** Renders a complete document. The body is the card content, below the `<h1>`. */
export const renderPage = (spec: PageSpec): string => {
  const heading = spec.heading ?? spec.title;
  const version = `?v=${PAGES_ASSET_VERSION}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${spec.title} · Bastion</title>
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="${fontUrl(400)}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${fontUrl(600)}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${PAGES_CSS_PATH}${version}">
<script src="${PAGES_THEME_PATH}${version}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<header class="brand">${BRAND_MARK}<span>Bastion</span></header>
<main id="main" class="card${spec.wide ? ' wide' : ''}" aria-labelledby="page-title">
<h1 id="page-title">${heading}</h1>
${spec.lede === undefined ? '' : html`<p class="lede">${spec.lede}</p>`}
${spec.body}
</main>
${spec.footnote === undefined ? '' : html`<footer class="foot">${spec.footnote}</footer>`}
</div>
</body>
</html>
`.value;
};

export type { SafeHtml };
