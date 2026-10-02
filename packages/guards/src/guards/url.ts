import { z } from 'zod';
import type { FindingSpan, Guard, GuardFinding } from '../types';
import { compileRe2, matchAllRanges } from './regex';

/**
 * `url` (13.4): extracts URLs from request arguments and checks their hosts against allow and deny lists,
 * so a fetch or email tool cannot send data to arbitrary domains. Default off.
 */

const URL_RE = compileRe2('\\b[A-Za-z][A-Za-z0-9+.-]{1,15}://[^\\s<>"\'`\\]\\[{}|\\\\^]+', '');
const TRAILING = /[.,;:!?)]+$/;

/** `example.com` matches that host only; `*.example.com` matches its subdomains, not the apex. */
export const hostMatches = (host: string, pattern: string): boolean => {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
};

export const urlConfigSchema = z.object({
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  /** When set, URLs with any other scheme are flagged like hosts that are not allowed. */
  schemes: z.array(z.string().min(1)).default([]),
});
export type UrlConfig = z.infer<typeof urlConfigSchema>;

export const urlGuard: Guard<UrlConfig> = {
  type: 'url',
  configSchema: urlConfigSchema,
  async evaluate(input, config) {
    const denied: FindingSpan[] = [];
    const notAllowed: FindingSpan[] = [];
    input.segments.forEach((seg, segment) => {
      if (seg.text === '') return;
      for (const m of matchAllRanges(URL_RE, seg.text)) {
        const value = m.value.replace(TRAILING, '');
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          continue;
        }
        const span = { segment, start: m.start, end: m.start + value.length };
        const host = url.hostname.toLowerCase().replace(/\.$/, '');
        const scheme = url.protocol.slice(0, -1).toLowerCase();
        if (config.schemes.length > 0 && !config.schemes.includes(scheme)) {
          notAllowed.push(span);
        } else if (config.deny.some((p) => hostMatches(host, p))) {
          denied.push(span);
        } else if (config.allow.length > 0 && !config.allow.some((p) => hostMatches(host, p))) {
          notAllowed.push(span);
        }
      }
    });
    const findings: GuardFinding[] = [];
    if (denied.length > 0) {
      findings.push({
        verdict: 'malicious',
        label: 'url-denied',
        ruleId: 'url-deny-list',
        spans: denied,
        action: 'block',
        category: 'policy',
        reason: 'URL host is on the deny list',
      });
    }
    if (notAllowed.length > 0) {
      findings.push({
        verdict: 'malicious',
        label: 'url-not-allowed',
        ruleId: 'url-allow-list',
        spans: notAllowed,
        action: 'block',
        category: 'policy',
        reason: 'URL host is not on the allow list',
      });
    }
    return findings;
  },
};
