import { isIPv6 } from 'node:net';
import type RE2 from 're2';
import { z } from 'zod';
import type { FindingSpan, Guard, GuardFinding } from '../types';
import { compileRe2, matchAllRanges } from './regex';

/**
 * `pii` (13.4): email, phone (E.164 and NANP), payment cards (Luhn), US SSN, IBAN (mod 97), IPv4 and
 * IPv6. Default off; the proposed action is `redact`.
 */

export const PII_ENTITIES = ['email', 'phone', 'card', 'ssn', 'iban', 'ipv4', 'ipv6'] as const;
export type PiiEntity = (typeof PII_ENTITIES)[number];

export const luhnValid = (digits: string): boolean => {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/** ISO 13616 mod-97 check; `iban` has no spaces. */
export const ibanValid = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const piece = code >= 65 ? String(code - 55) : ch;
    for (const digit of piece) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
};

const ssnValid = (value: string): boolean => {
  const [area, group, serial] = value.split('-');
  if (area === undefined || group === undefined || serial === undefined) return false;
  return (
    area !== '000' && area !== '666' && !area.startsWith('9') && group !== '00' && serial !== '0000'
  );
};

const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

type Recognizer = {
  entity: PiiEntity;
  re: RE2;
  /** Return false to reject a candidate; `before` and `after` are the neighbouring characters. */
  accept: (value: string, before: string, after: string) => boolean;
};

const recognizers: Recognizer[] = [
  {
    entity: 'email',
    re: compileRe2(
      '\\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,8}\\.[A-Za-z]{2,24}\\b',
      '',
    ),
    accept: () => true,
  },
  {
    entity: 'phone',
    // E.164 with optional separators.
    re: compileRe2('\\+[1-9](?:[ .-]?\\d){7,14}', ''),
    accept: (_v, before, after) => !isWordChar(before) && !/\d/.test(after),
  },
  {
    entity: 'phone',
    // NANP: (212) 555-0123, 212-555-0123, 1-212-555-0123.
    re: compileRe2(
      '(?:\\b1[ .-]?)?(?:\\([2-9]\\d{2}\\)[ .-]?|\\b[2-9]\\d{2}[ .-])[2-9]\\d{2}[ .-]\\d{4}\\b',
      '',
    ),
    accept: (_v, before) => before !== '-' && before !== '+' && !/\d/.test(before),
  },
  {
    entity: 'card',
    re: compileRe2('\\b\\d(?:[ -]?\\d){12,18}\\b', ''),
    accept: (value) => {
      const digits = value.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    entity: 'ssn',
    re: compileRe2('\\b\\d{3}-\\d{2}-\\d{4}\\b', ''),
    accept: (value, before, after) => ssnValid(value) && before !== '-' && after !== '-',
  },
  {
    entity: 'iban',
    re: compileRe2('\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\\b', ''),
    accept: (value) => ibanValid(value.replace(/ /g, '')),
  },
  {
    entity: 'ipv4',
    re: compileRe2(
      '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b',
      '',
    ),
    accept: (_v, before, after) => before !== '.' && after !== '.' && before !== '-',
  },
  {
    entity: 'ipv6',
    re: compileRe2('(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}', ''),
    accept: (value, before, after) =>
      /[0-9A-Fa-f]/.test(value) &&
      !/[0-9A-Za-z:]/.test(before) &&
      !/[0-9A-Za-z:]/.test(after) &&
      isIPv6(value),
  },
];

export const piiConfigSchema = z.object({
  entities: z
    .array(z.enum(PII_ENTITIES))
    .min(1)
    .default([...PII_ENTITIES]),
});
export type PiiConfig = z.infer<typeof piiConfigSchema>;

export const piiGuard: Guard<PiiConfig> = {
  type: 'pii',
  configSchema: piiConfigSchema,
  async evaluate(input, config) {
    const active = recognizers.filter((r) => config.entities.includes(r.entity));
    const spans = new Map<PiiEntity, FindingSpan[]>();
    input.segments.forEach((seg, segment) => {
      if (seg.text === '') return;
      for (const rec of active) {
        for (const m of matchAllRanges(rec.re, seg.text)) {
          const before = m.start > 0 ? seg.text.charAt(m.start - 1) : '';
          const after = m.end < seg.text.length ? seg.text.charAt(m.end) : '';
          if (!rec.accept(m.value, before, after)) continue;
          const list = spans.get(rec.entity) ?? [];
          list.push({ segment, start: m.start, end: m.end });
          spans.set(rec.entity, list);
        }
      }
    });
    const findings: GuardFinding[] = [];
    for (const [entity, list] of spans) {
      findings.push({
        verdict: 'suspicious',
        label: `pii:${entity}`,
        ruleId: entity,
        spans: list,
        action: 'redact',
        category: 'sensitive-data',
        reason: `${entity} detected`,
      });
    }
    return findings;
  },
};
