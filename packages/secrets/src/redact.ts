/** pino `redact.paths` (15.4). */
export const LOG_REDACT_PATHS = [
  'authorization',
  'cookie',
  '*.token',
  '*.secret',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
] as const;

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'token',
  'secret',
  'password',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'apikey',
  'privatekey',
]);

const normalize = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(normalize(key));

const MAX_DEPTH = 32;

/** Deep copy with the values of sensitive keys masked (audit diffs, previews). Cycle-safe. */
export const scrub = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    if (v instanceof Date) return v;
    if (depth >= MAX_DEPTH || seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [
          k,
          isSensitiveKey(k) ? REDACTED : walk(item, depth + 1),
        ]),
      );
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
};

/** Masks bearer tokens and any of the given known secret values inside free text. */
export const redactSecrets = (text: string, secrets: readonly string[] = []): string => {
  let out = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  return out;
};
