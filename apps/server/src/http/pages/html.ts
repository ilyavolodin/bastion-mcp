/**
 * A tiny escaping HTML builder. Every value interpolated into `html\`...\`` is escaped unless it is already
 * `SafeHtml` (the result of another `html` call or an explicit `raw`), so a template cannot forget to escape.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Escapes text for element content and for double- or single-quoted attribute values. */
export const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export type Child = string | number | boolean | null | undefined | SafeHtml | readonly Child[];

const render = (child: Child): string => {
  if (child === null || child === undefined || child === false || child === true) return '';
  if (child instanceof SafeHtml) return child.value;
  if (Array.isArray(child)) return child.map(render).join('');
  return escapeHtml(child);
};

/** Trusted markup: only for literals in this module and markup produced by a library (never user input). */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

export const html = (strings: TemplateStringsArray, ...values: Child[]): SafeHtml => {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i] as Child) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
};

/** Joins children (escaped) into one fragment. */
export const fragment = (children: readonly Child[]): SafeHtml => new SafeHtml(render(children));

/** Only `https:` (and loopback `http:`) absolute URLs may be used as image sources of third-party data. */
export const safeImageUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
