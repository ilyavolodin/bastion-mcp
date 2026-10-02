/**
 * Resource URI helpers: the `bastion+{slug}:` prefix (7.4, 12.3) and the small subset of RFC 6570
 * that resource templates use (pinned variable substitution and read-time matching).
 */

export const uriPrefixOf = (installationSlug: string): string => `bastion+${installationSlug}:`;

/** `bastion+{installationSlug}:{original}` (7.4). */
export const addUriPrefix = (installationSlug: string, uri: string): string =>
  `${uriPrefixOf(installationSlug)}${uri}`;

/** The original URI when `uri` carries this installation's prefix, otherwise `null`. */
export const stripUriPrefix = (uri: string, installationSlug: string): string | null => {
  const prefix = uriPrefixOf(installationSlug);
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
};

/** Splits any `bastion+{slug}:{rest}` URI so the router can pick the installation by slug. */
export const parseUriPrefix = (uri: string): { slug: string; uri: string } | null => {
  const match = /^bastion\+([^:]+):([\s\S]*)$/.exec(uri);
  return match ? { slug: match[1] as string, uri: match[2] as string } : null;
};

const EXPRESSION = /\{([+#./;?&]?)([^{}]+)\}/g;

const variableNames = (list: string): string[] =>
  list.split(',').map((v) => v.replace(/(:\d+|\*)$/, '').trim());

/** Names of all variables in a template, in order. */
export const templateVariables = (template: string): string[] => {
  const names: string[] = [];
  for (const m of template.matchAll(EXPRESSION)) names.push(...variableNames(m[2] as string));
  return names;
};

export type PinResult = { ok: true; template: string } | { ok: false; error: string };

/**
 * Substitutes pinned values into the advertised template: `repo://{owner}/{repo}` with
 * `{owner: 'acme'}` becomes `repo://acme/{repo}`. Only plain (`{v}`), reserved (`{+v}`) and
 * fragment (`{#v}`) expressions can be pinned; a pinned variable inside any other operator or in a
 * multi-variable expression is an error.
 */
export const pinTemplateVariables = (
  template: string,
  pinned: Readonly<Record<string, string>>,
): PinResult => {
  let error: string | undefined;
  const out = template.replace(EXPRESSION, (whole, op: string, list: string) => {
    const names = variableNames(list);
    const hits = names.filter((n) => n in pinned);
    if (hits.length === 0) return whole;
    if (names.length > 1 || !['', '+', '#'].includes(op)) {
      error ??= `cannot pin variable "${hits.join(', ')}" inside ${whole}`;
      return whole;
    }
    const value = pinned[names[0] as string] as string;
    return op === '' ? encodeURIComponent(value) : `${op === '#' ? '#' : ''}${encodeURI(value)}`;
  });
  return error === undefined ? { ok: true, template: out } : { ok: false, error };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Matches `uri` against a template and returns the (decoded) variables, or `null`. Query
 * expansions (`{?a,b}`, `{&a}`) match any query string and are not captured.
 */
export const matchUriTemplate = (template: string, uri: string): Record<string, string> | null => {
  const names: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of template.matchAll(EXPRESSION)) {
    pattern += escapeRegExp(template.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const op = m[1] as string;
    const vars = variableNames(m[2] as string);
    if (op === '?' || op === '&') {
      pattern += '(?:\\?[^#]*)?';
      continue;
    }
    names.push(...vars);
    const cls = op === '+' || op === '#' ? '.+?' : op === '' ? '[^/?#,]+' : '[^?#]*';
    const groups = vars.map(() => `(${cls})`).join(',');
    pattern += `${op === '#' ? '#' : ''}${groups}`;
  }
  pattern += escapeRegExp(template.slice(last));
  const match = new RegExp(`^${pattern}$`).exec(uri);
  if (!match) return null;
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    out[n] = safeDecode(match[i + 1] as string);
  });
  return out;
};
