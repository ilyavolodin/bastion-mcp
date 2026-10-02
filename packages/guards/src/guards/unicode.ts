import { z } from 'zod';
import type { FindingSpan, Guard, GuardFinding } from '../types';

/**
 * `unicode` (13.4): Unicode tag characters (U+E0000..E007F), zero-width characters, bidirectional
 * overrides and other invisible format characters used for ASCII smuggling. Default action: strip.
 */

// Tags and variation selectors supplement, bidi controls, zero-width and invisible format characters.
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the class lists invisible characters on purpose
  /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u200B-\u200D\u2060-\u2064\u206A-\u206F\u202A-\u202E\u2066-\u2069\u061C\u180E\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u115F\u1160\u3164\uFFA0]/gu;

// biome-ignore lint/suspicious/noMisleadingCharacterClass: variation selectors are listed on purpose
const TAG = /^[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]$/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const isNonAscii = (ch: string): boolean => (ch.codePointAt(0) ?? 0) > 0x7f;
const LETTER = /\p{L}/u;

const charBefore = (text: string, index: number): string => {
  if (index === 0) return '';
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text.charAt(index - 1);
};

const charAt = (text: string, index: number): string => {
  const cp = text.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
};

/** Legitimate uses: emoji ZWJ sequences and variation selectors, ZWNJ/ZWJ between non-Latin letters. */
const isBenignContext = (ch: string, text: string, index: number): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  const before = charBefore(text, index);
  if (code === 0xfeff) return index === 0;
  if (code >= 0xfe00 && code <= 0xfe0f) {
    return EMOJI.test(before) || /^[0-9#*]$/.test(before);
  }
  if (code === 0x200d) {
    if (EMOJI.test(before)) return true;
  }
  if (code === 0x200c || code === 0x200d) {
    const after = charAt(text, index + 1);
    return (
      before !== '' &&
      after !== '' &&
      isNonAscii(before) &&
      isNonAscii(after) &&
      LETTER.test(before) &&
      LETTER.test(after)
    );
  }
  return false;
};

export const findInvisibleSpans = (
  text: string,
): { start: number; end: number; tag: boolean }[] => {
  const spans: { start: number; end: number; tag: boolean }[] = [];
  INVISIBLE.lastIndex = 0;
  for (let m = INVISIBLE.exec(text); m !== null; m = INVISIBLE.exec(text)) {
    const ch = m[0];
    if (isBenignContext(ch, text, m.index)) continue;
    const end = m.index + ch.length;
    const last = spans[spans.length - 1];
    const tag = TAG.test(ch);
    if (last !== undefined && last.end === m.index && last.tag === tag) {
      last.end = end;
    } else {
      spans.push({ start: m.index, end, tag });
    }
  }
  return spans;
};

export const unicodeConfigSchema = z.object({});
export type UnicodeConfig = z.infer<typeof unicodeConfigSchema>;

export const unicodeGuard: Guard<UnicodeConfig> = {
  type: 'unicode',
  configSchema: unicodeConfigSchema,
  async evaluate(input) {
    const findings: GuardFinding[] = [];
    input.segments.forEach((seg, segment) => {
      if (seg.text === '') return;
      const spans = findInvisibleSpans(seg.text);
      if (spans.length === 0) return;
      const byKind = (pick: (s: (typeof spans)[number]) => boolean): FindingSpan[] =>
        spans.filter(pick).map((s) => ({ segment, start: s.start, end: s.end }));
      const tags = byKind((s) => s.tag);
      const rest = byKind((s) => !s.tag);
      if (tags.length > 0) {
        findings.push({
          verdict: 'malicious',
          label: 'unicode-tag',
          ruleId: 'unicode-tag',
          spans: tags,
          action: 'redact',
          strip: true,
          category: 'invisible-text',
          reason: 'Unicode tag characters can hide instructions (ASCII smuggling)',
        });
      }
      if (rest.length > 0) {
        findings.push({
          verdict: 'suspicious',
          label: 'invisible-unicode',
          ruleId: 'invisible-unicode',
          spans: rest,
          action: 'redact',
          strip: true,
          category: 'invisible-text',
          reason: 'Invisible, zero-width or bidirectional control characters',
        });
      }
    });
    return findings;
  },
};
