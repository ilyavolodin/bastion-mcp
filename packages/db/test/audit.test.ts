import { describe, expect, it } from 'vitest';
import { type AuditRow, computeAuditHash, GENESIS_HASH, verifyAuditRows } from '../src/audit';

const row = (
  n: number,
  overrides: Partial<AuditRow> = {},
): Omit<AuditRow, 'hash' | 'prevHash'> => ({
  seq: BigInt(n),
  id: `00000000-0000-7000-8000-00000000000${n}`,
  ts: new Date(Date.UTC(2026, 9, 1, 0, 0, n)),
  actorType: 'user',
  actorId: 'u1',
  action: 'catalog.publish',
  targetType: 'catalog_entry',
  targetId: 'e1',
  diff: { before: null, after: { status: 'published' } },
  ip: '10.0.0.1',
  userAgent: 'jest',
  requestId: `req-${n}`,
  ...overrides,
});

const chain = (count: number): AuditRow[] => {
  const rows: AuditRow[] = [];
  let prev: Buffer = GENESIS_HASH;
  for (let i = 1; i <= count; i++) {
    const base = row(i);
    const hash = computeAuditHash(prev, base);
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
};

describe('15.6 audit hash chain', () => {
  it('hash = sha256(prev_hash || canonical_row), deterministic and key-order independent', () => {
    const a = computeAuditHash(GENESIS_HASH, row(1));
    const b = computeAuditHash(GENESIS_HASH, {
      ...row(1),
      diff: { after: { status: 'published' }, before: null },
    });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('changes when the previous hash or any field changes', () => {
    const base = computeAuditHash(GENESIS_HASH, row(1));
    expect(computeAuditHash(base, row(1)).equals(base)).toBe(false);
    expect(computeAuditHash(GENESIS_HASH, row(1, { action: 'x' })).equals(base)).toBe(false);
  });

  it('verifies an intact chain', () => {
    expect(verifyAuditRows(chain(5))).toEqual({ ok: true, checked: 5 });
  });

  it('detects a modified row and reports its sequence number', () => {
    const rows = chain(5);
    rows[2] = { ...(rows[2] as AuditRow), action: 'tampered' };
    expect(verifyAuditRows(rows)).toEqual({ ok: false, checked: 2, brokenAtSeq: 3n });
  });

  it('detects a deleted row (broken link)', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    const result = verifyAuditRows(rows);
    expect(result.ok).toBe(false);
  });
});
