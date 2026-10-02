/**
 * Form schemas and body builders of the Registry screen. Each zod schema mirrors the request schema it feeds
 * (`packages/api/src/schemas/registry.ts`) and each `toBody` returns the generated request type.
 */
import { z } from 'zod';
import type { Body } from '@/api/schema';
import type { RegistryServer } from '@/api/views/registry';

/** `requestCreateSchema`: a justification of 1 to 2000 characters. */
export const requestFormSchema = z.object({
  justification: z
    .string()
    .trim()
    .min(1, 'Say what you need it for')
    .max(2000, 'At most 2000 characters'),
});
export type RequestForm = z.infer<typeof requestFormSchema>;

export const requestToBody = (
  server: Pick<RegistryServer, 'sourceId' | 'name' | 'version'>,
  v: RequestForm,
): Body<'post', '/install-requests'> => ({
  sourceId: server.sourceId,
  name: server.name,
  version: server.version,
  justification: v.justification,
});

/** `requestRejectSchema`: a reason of 1 to 2000 characters. */
export const rejectFormSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(2000, 'At most 2000 characters'),
});
export type RejectForm = z.infer<typeof rejectFormSchema>;

export const rejectToBody = (v: RejectForm): Body<'post', '/install-requests/{id}/reject'> => ({
  reason: v.reason,
});

/** `installBodySchema`: the version of a listed server, with the justification when the policy asks for approval. */
export const installToBody = (
  server: Pick<RegistryServer, 'sourceId' | 'name' | 'version'>,
): Body<'post', '/registry/install'> => ({
  sourceId: server.sourceId,
  name: server.name,
  version: server.version,
});
