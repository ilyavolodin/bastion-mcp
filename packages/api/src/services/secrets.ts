import { NotFoundApiError } from '../errors';
import type { SecretMeta, SecretScope } from '../ports/secrets';
import type { ReadCtx, WriteCtx } from './crud';

/** Org secrets have no owner; the path segment is ignored for them (22.3). */
export const ownerOf = (scope: SecretScope, ownerId: string | undefined): string | null =>
  scope === 'org' ? null : (ownerId ?? null);

export const listSecrets = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  scope: SecretScope,
  ownerId: string | undefined,
): Promise<SecretMeta[]> => {
  const owner = scope === 'user' ? (ownerId ?? ctx.principal.id) : ownerOf(scope, ownerId);
  return ctx.deps.secrets.list({ scope, ownerId: owner });
};

export const secretVersion = async (
  ctx: Pick<ReadCtx, 'deps'>,
  scope: SecretScope,
  ownerId: string,
  name: string,
): Promise<string | null> => {
  const owner = ownerOf(scope, ownerId);
  const found = (await ctx.deps.secrets.list({ scope, ownerId: owner })).find(
    (s) => s.name === name,
  );
  return found?.updatedAt ?? null;
};

/** The value is written and forgotten: only metadata is returned or audited (22.3). */
export const putSecret = async (
  ctx: WriteCtx,
  scope: SecretScope,
  ownerId: string,
  name: string,
  value: string,
): Promise<SecretMeta> => {
  const meta = await ctx.deps.secrets.put({ scope, ownerId: ownerOf(scope, ownerId), name, value });
  await ctx.tx.audit({
    action: 'secret.put',
    targetType: 'secret',
    targetId: meta.id,
    diff: { scope, ownerId: meta.ownerId, name, version: meta.version },
  });
  return meta;
};

export const deleteSecret = async (
  ctx: WriteCtx,
  scope: SecretScope,
  ownerId: string,
  name: string,
): Promise<void> => {
  const owner = ownerOf(scope, ownerId);
  const removed = await ctx.deps.secrets.delete({ scope, ownerId: owner, name });
  if (!removed) throw new NotFoundApiError('secret');
  await ctx.tx.audit({
    action: 'secret.delete',
    targetType: 'secret',
    targetId: `${scope}/${owner ?? ''}/${name}`,
    diff: { scope, ownerId: owner, name },
  });
};
