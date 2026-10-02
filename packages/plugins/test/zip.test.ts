import fc from 'fast-check';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  exportZip,
  importZip,
  type PluginFile,
  PluginValidationError,
  stripWrapperDirectory,
  textFile,
} from '../src';
import { SKILL_MD } from './helpers/fixtures';

const rawZip = (
  entries: Record<string, [Uint8Array, { os?: number; attrs?: number }?]>,
): Uint8Array => {
  const input: Record<string, [Uint8Array, { os?: number; attrs?: number }]> = {};
  for (const [name, [data, opts]] of Object.entries(entries)) input[name] = [data, opts ?? {}];
  return zipSync(input);
};
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const unixAttrs = (mode: number): { os: number; attrs: number } => ({
  os: 3,
  attrs: (mode << 16) >>> 0,
});

describe('25.3 zip import', () => {
  it('25.3 round-trips a skill directory through exportZip and importZip, keeping exec bits', () => {
    const files: PluginFile[] = [
      textFile('SKILL.md', SKILL_MD('a')),
      textFile('scripts/run.sh', '#!/bin/sh\n', 'executable'),
      textFile('references/x.md', 'x'),
    ];
    const imported = importZip(exportZip(files));
    expect(imported.map((f) => [f.path, f.mode])).toEqual([
      ['SKILL.md', 'file'],
      ['references/x.md', 'file'],
      ['scripts/run.sh', 'executable'],
    ]);
  });

  it('25.2 rejects zip-slip, absolute paths and backslashes', () => {
    for (const name of ['../evil.txt', 'a/../../evil.txt', '/abs.txt', 'a\\b.txt', 'C:/x.txt']) {
      expect(() => importZip(rawZip({ [name]: [bytes('x')] })), name).toThrow(
        PluginValidationError,
      );
    }
  });

  it('25.2 rejects symlinks and special files recorded in the Unix mode', () => {
    expect(() => importZip(rawZip({ link: [bytes('target'), unixAttrs(0o120777)] }))).toThrow(
      /symlink/,
    );
    expect(() => importZip(rawZip({ dev: [bytes(''), unixAttrs(0o060000)] }))).toThrow(/special/);
  });

  it('25.2 rejects duplicate entries', () => {
    const a = rawZip({ 'a.txt': [bytes('1')] });
    // two entries with the same normalized path: ./a.txt and a.txt
    expect(() => importZip(rawZip({ 'a.txt': [bytes('1')], './a.txt': [bytes('2')] }))).toThrow(
      /duplicate/,
    );
    expect(a.length).toBeGreaterThan(0);
  });

  it('25.2 enforces limits from the central directory before inflating', () => {
    const limits = { maxUnpackedBytes: 1000, maxFiles: 2, maxFileBytes: 600 };
    expect(() =>
      importZip(rawZip({ a: [bytes('1')], b: [bytes('2')], c: [bytes('3')] }), { limits }),
    ).toThrow(/files/);
    expect(() => importZip(rawZip({ a: [new Uint8Array(601)] }), { limits })).toThrow(/larger/);
    expect(() =>
      importZip(rawZip({ a: [new Uint8Array(500).fill(7)], b: [new Uint8Array(600).fill(9)] }), {
        limits,
      }),
    ).toThrow(/unpacked/);
  });

  it('25.2 rejects a zip bomb by compression ratio', () => {
    const bomb = rawZip({ 'zeros.bin': [new Uint8Array(4 * 1024 * 1024)] });
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => importZip(bomb)).toThrow(/ratio/);
  });

  it('25.2 rejects archives whose declared sizes lie about the inflated content', () => {
    const zip = rawZip({ 'a.txt': [bytes('hello hello hello hello hello')] });
    const patched = new Uint8Array(zip);
    const view = new DataView(patched.buffer);
    // Central directory entry: uncompressed size at +24.
    for (let i = 0; i + 46 < patched.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, view.getUint32(i + 24, true) + 40, true);
        break;
      }
    }
    expect(() => importZip(patched)).toThrow(PluginValidationError);
  });

  it('25.2 rejects non-zip input and corrupt central directories', () => {
    expect(() => importZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a zip/);
    const zip = new Uint8Array(rawZip({ a: [bytes('x')] }));
    const view = new DataView(zip.buffer);
    for (let i = 0; i + 4 < zip.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i, 0, true);
    }
    expect(() => importZip(zip)).toThrow(/corrupt/);
  });

  it('25.3 strips a single wrapping directory but keeps known plugin roots', () => {
    const wrapped = importZip(
      rawZip({ 'my-skill/SKILL.md': [bytes(SKILL_MD('my-skill'))], 'my-skill/a.md': [bytes('a')] }),
    );
    expect(wrapped.map((f) => f.path)).toEqual(['SKILL.md', 'a.md']);
    const plugin = importZip(rawZip({ 'skills/x/SKILL.md': [bytes('s')] }));
    expect(plugin.map((f) => f.path)).toEqual(['skills/x/SKILL.md']);
    expect(importZip(rawZip({ 'w/a.md': [bytes('a')] }), { stripWrapper: false })[0]?.path).toBe(
      'w/a.md',
    );
    const mixed = [textFile('d/a', ''), textFile('b', '')];
    expect(stripWrapperDirectory(mixed)).toBe(mixed);
  });

  it('25.3 ignores directory entries', () => {
    const zip = rawZip({ 'dir/': [new Uint8Array(0)], 'dir/a.md': [bytes('a')] });
    expect(importZip(zip, { stripWrapper: false }).map((f) => f.path)).toEqual(['dir/a.md']);
  });
});

describe('25.5 deterministic archives', () => {
  const files = [
    textFile('plugin.json', '{}'),
    textFile('skills/a/SKILL.md', SKILL_MD('a')),
    textFile('hooks/run.sh', '#!/bin/sh', 'executable'),
  ];

  it('25.5 produces identical bytes regardless of input order', () => {
    const a = exportZip(files);
    const b = exportZip([...files].reverse());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('25.5 sorts entries, fixes timestamps at 1980-01-01 and adds no extra fields', () => {
    const zip = exportZip(files);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const names: string[] = [];
    let offset = 0;
    for (; offset + 46 < zip.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const time = view.getUint16(offset + 12, true);
      const date = view.getUint16(offset + 14, true);
      expect(time).toBe(0);
      expect(date).toBe((0 << 9) | (1 << 5) | 1); // 1980-01-01
      expect(view.getUint16(offset + 30, true)).toBe(0); // extra field length
      const nameLength = view.getUint16(offset + 28, true);
      names.push(new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength)));
    }
    expect(names).toEqual(['hooks/run.sh', 'plugin.json', 'skills/a/SKILL.md']);
  });

  it('25.5 property: export then import returns the same tree', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.tuple(
            fc.stringMatching(/^[a-z0-9]{1,6}(\/[a-z0-9]{1,6}){0,2}$/),
            fc.uint8Array({ maxLength: 40 }),
          ),
          {
            selector: ([p]) => p,
            minLength: 2,
            maxLength: 6,
          },
        ),
        (entries) => {
          fc.pre(entries.every(([p]) => !entries.some(([q]) => q.startsWith(`${p}/`))));
          const input: PluginFile[] = entries.map(([path, content]) => ({
            path,
            content,
            mode: 'file',
          }));
          const back = importZip(exportZip(input), { stripWrapper: false });
          expect(back.map((f) => [f.path, Buffer.from(f.content).toString('hex')]).sort()).toEqual(
            input.map((f) => [f.path, Buffer.from(f.content).toString('hex')]).sort(),
          );
        },
      ),
      { numRuns: 40 },
    );
  });
});
