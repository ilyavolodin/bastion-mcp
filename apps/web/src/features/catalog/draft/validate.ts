import {
  injectedRows,
  oauthRefsOf,
  secretNamesOf,
  secretRefsOf,
  templateError,
  varRefsOf,
} from './secrets';
import type { AuthMode, Draft } from './types';

// --- constraints (mirrors of the API schemas) ------------------------------------------------------------------

/** `EXACT_VERSION` of `packages/core/src/server-spec.ts` (8.7): ranges, tags and `latest` are rejected. */
export const EXACT_VERSION = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
/** Names of `{{var.NAME}}` and `{{secret.NAME}}` references (`packages/core/src/template.ts`). */
export const TEMPLATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP field name (RFC 9110 token). */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `host[:port]`, `*.suffix[:port]` or a CIDR (`isValidEgressRule`, 8.8). */
export const isEgressRule = (raw: string): boolean => {
  const value = raw.trim().toLowerCase();
  if (value.includes('/')) {
    const [net = '', prefix = ''] = value.split('/');
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(net);
    const v6 = net.includes(':') && /^[0-9a-f:.]+$/.test(net);
    return /^\d+$/.test(prefix) && ((v4 && Number(prefix) <= 32) || (v6 && Number(prefix) <= 128));
  }
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(value);
  const host = m?.[1] ?? '';
  if (m?.[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return false;
  if (host.startsWith('*.')) return HOSTNAME.test(host.slice(2));
  return HOSTNAME.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
};

/**
 * An IPv4 CIDR rule that is not a private, loopback, link-local or shared (CGNAT) range. A CIDR rule exists to allow
 * what the SSRF check refuses (8.8), which are exactly those ranges, so a public one is almost always a typo
 * (`192.16.1.2` for `192.168.1.2`). Anything that is not an IPv4 CIDR is not reported.
 */
export const isPublicIpv4Cidr = (raw: string): boolean => {
  const [net = '', prefix = ''] = raw.trim().split('/');
  const octets = net.split('.').map(Number);
  if (
    octets.length !== 4 ||
    prefix === '' ||
    octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
  )
    return false;
  const [a = 0, b = 0] = octets;
  const private_ =
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
  return !private_;
};

export const LIMITS = {
  displayName: 200,
  slug: 63,
  description: 4000,
  label: 64,
  changelog: 10000,
} as const;

// --- validation -------------------------------------------------------------------------------------------------------

export type Issue = { step: string; message: string };

const looksSecretMode = (m: AuthMode) => m === 'orgSecret' || m === 'userSecret';

/** Every reason the draft cannot be saved, with the step that fixes it. */
export const validateDraft = (d: Draft): Issue[] => {
  const issues: Issue[] = [];
  const add = (step: string, message: string) => issues.push({ step, message });
  if (!d.displayName.trim()) add('source', 'Give the entry a name');
  if (d.displayName.trim().length > LIMITS.displayName) add('source', 'The name is too long');
  if (!d.slug || d.slug.length > LIMITS.slug)
    add('source', 'The URL name needs 1 to 63 characters');
  if (d.description.length > LIMITS.description) add('source', 'The description is too long');
  if (!d.label.trim() || d.label.length > LIMITS.label)
    add('source', 'The version label needs 1 to 64 characters');
  if (d.overridesError) add('overrides', `The override document is not valid: ${d.overridesError}`);
  const s = d.spec;
  if (s.type === 'package') {
    if (!s.identifier.trim()) add('source', 'Name the package');
    if (!EXACT_VERSION.test(s.version))
      add('source', 'Pin an exact package version, for example 3.2.0');
  } else if (!s.url.trim()) add('source', 'Give the server URL');

  const declared = new Set(s.variables.map((v) => v.name));
  const names = new Set<string>();
  for (const v of s.variables) {
    if (!TEMPLATE_NAME.test(v.name))
      add('configuration', `"${v.name || '(empty)'}" is not a valid variable name`);
    if (names.has(v.name)) add('configuration', `${v.name} is declared twice`);
    names.add(v.name);
    const choices = splitChoices(v.choices);
    if (v.default && choices.length > 0 && !choices.includes(v.default))
      add('configuration', `The default of ${v.name} is not one of its choices`);
  }

  const checkTemplate = (step: string, where: string, value: string) => {
    const error = templateError(value);
    if (error) {
      add(step, `${where}: ${error}`);
      return;
    }
    for (const ref of varRefsOf(value)) {
      if (!declared.has(ref)) add(step, `${where} uses {{var.${ref}}}, which is not a variable`);
    }
  };

  if (s.type === 'remote') checkTemplate('source', 'The server URL', s.url);

  const seenHeaders = new Set<string>();
  if (s.type === 'remote') {
    for (const h of s.headers) {
      const label = h.name ? `Header ${h.name}` : 'A header';
      if (!HEADER_NAME.test(h.name))
        add('authentication', `"${h.name}" is not a valid header name`);
      else if (seenHeaders.has(h.name.toLowerCase()))
        add('authentication', `Header ${h.name} is declared twice`);
      seenHeaders.add(h.name.toLowerCase());
      if (!h.value.trim()) add('authentication', `${label} needs a value`);
      else checkTemplate('authentication', label, h.value);
    }
  } else {
    const seenEnv = new Set<string>();
    for (const e of s.envVars) {
      const label = e.name ? `Environment variable ${e.name}` : 'An environment variable';
      if (!TEMPLATE_NAME.test(e.name))
        add('configuration', `"${e.name || '(empty)'}" is not a valid environment variable name`);
      else if (seenEnv.has(e.name)) add('configuration', `${e.name} is set twice`);
      seenEnv.add(e.name);
      if (!e.value.trim() && !e.secret) add('configuration', `${label} needs a value`);
      else checkTemplate('configuration', label, e.value);
    }
    for (const a of s.args) {
      const label = a.name ? `Argument ${a.name}` : 'An argument';
      if (a.kind === 'named' && !a.name.trim())
        add('configuration', 'A named argument needs a flag');
      if (!a.value.trim()) add('configuration', `${label} needs a value`);
      else checkTemplate('configuration', label, a.value);
    }
  }

  // Credentials (9.5).
  const injected = injectedRows(s);
  const secretNames = secretNamesOf(s);
  for (const row of injected) {
    const where = row.name ? `"${row.name}"` : 'A secret binding';
    if (s.authMode === 'oauth') {
      if (oauthRefsOf(row.value).length === 0 && secretRefsOf(row.value).length === 0)
        add('authentication', `${where} is marked secret but its value has no reference`);
    } else if (secretRefsOf(row.value).length === 0) {
      add('authentication', `${where} is marked secret: its value needs {{secret.NAME}}`);
    }
  }
  const plain = (s.type === 'remote' ? s.headers : [...s.envVars, ...s.args]).filter(
    (r) => !r.secret,
  );
  for (const row of plain) {
    if (secretRefsOf(row.value).length > 0)
      add(
        'authentication',
        `${row.name ? `"${row.name}"` : 'A value'} uses a secret: switch Secret on for it`,
      );
  }
  for (const name of secretNames) {
    if (!TEMPLATE_NAME.test(name))
      add('authentication', `"${name}" is not a valid secret name (letters, digits, underscore)`);
  }
  if (secretNames.length > 0 && !looksSecretMode(s.authMode))
    add(
      'authentication',
      'Secrets need an author-set or per-person source: choose Shared secret or Personal secret',
    );
  if (looksSecretMode(s.authMode) && secretNames.length === 0)
    add(
      'authentication',
      s.type === 'remote'
        ? 'Add a header that carries the secret, for example a Bearer token'
        : 'Add an environment variable or argument that carries the secret',
    );
  if (
    s.authMode === 'oauth' &&
    s.oauthClient.registration === 'preRegistered' &&
    !s.oauthClient.clientId.trim()
  )
    add('authentication', 'Enter the client ID of the OAuth app you registered');
  if (s.authMode === 'oauth' && s.type === 'package' && injected.length === 0)
    add('authentication', 'Say where the access token goes: add a secret environment variable');
  for (const rule of s.egress)
    if (!isEgressRule(rule))
      add('network', `"${rule}" is not host[:port], *.suffix[:port] or a CIDR`);
  return issues;
};

export const splitChoices = (raw: string): string[] =>
  raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
