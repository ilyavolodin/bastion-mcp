import { describe, expect, it } from 'vitest';
import { approveSchema, rejectSchema, toApproveBody, toRejectBody } from './forms';

describe('drift review forms (13.6)', () => {
  it('a rejection needs a reason, trimmed, at most 2000 characters', () => {
    expect(rejectSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(rejectSchema.safeParse({ reason: 'r'.repeat(2001) }).success).toBe(false);
    expect(rejectSchema.safeParse({ reason: 'r'.repeat(2000) }).success).toBe(true);
    expect(toRejectBody({ reason: '  too risky  ' })).toEqual({ reason: 'too risky' });
  });

  it('an approval may have no note, and sends none then', () => {
    expect(approveSchema.safeParse({ note: '' }).success).toBe(true);
    expect(toApproveBody({ note: '   ' })).toEqual({});
    expect(toApproveBody({ note: ' looks fine ' })).toEqual({ note: 'looks fine' });
  });

  it('a note is limited to 2000 characters', () => {
    const r = approveSchema.safeParse({ note: 'n'.repeat(2001) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('Keep the note under 2000 characters');
  });
});
