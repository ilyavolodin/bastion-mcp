import { z } from 'zod';
import type { Body } from '@/api/schema';

/** Same limits as the API (`driftRejectSchema`, `driftApproveSchema`): a reason is required, a note is optional. */
export const rejectSchema = z.object({
  reason: z.string().trim().min(1, 'Say why the new definition stays blocked').max(2000),
});
export const approveSchema = z.object({
  note: z.string().trim().max(2000, 'Keep the note under 2000 characters'),
});

export type RejectValues = z.input<typeof rejectSchema>;
export type ApproveValues = z.input<typeof approveSchema>;

export const toRejectBody = (v: RejectValues): Body<'post', '/drift-reviews/{id}/reject'> => ({
  reason: v.reason.trim(),
});

export const toApproveBody = (v: ApproveValues): Body<'post', '/drift-reviews/{id}/approve'> =>
  v.note.trim() ? { note: v.note.trim() } : {};
