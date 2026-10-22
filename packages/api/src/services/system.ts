import type { Principal } from '@bastion-mcp/auth';
import type { ApiDeps } from '../ports';
import type { WriteCtx } from './crud';

export const systemStatus = (deps: ApiDeps) => deps.system.status();

/** Rotates the KEK; the data keys are rewrapped by the port (22.3). */
export const rotateKms = async (ctx: WriteCtx) => {
  const result = await ctx.deps.system.rotateKms();
  await ctx.tx.audit({
    action: 'system.kms.rotate',
    targetType: 'system',
    targetId: 'kms',
    diff: { kekRef: result.kekRef, rewrapped: result.rewrapped },
  });
  return result;
};

/** New keys appear in the JWKS; `signing_keys` makes every worker reload them (9.3). */
export const rotateSigningKeys = async (ctx: WriteCtx) => {
  const result = await ctx.deps.system.rotateSigningKeys();
  await ctx.tx.audit({
    action: 'system.signing_keys.rotate',
    targetType: 'system',
    targetId: 'signing_keys',
    diff: { kids: result.kids },
  });
  ctx.tx.configChanged('signing_keys');
  return result;
};

type Actor = { deps: ApiDeps; principal: Principal };

export const createBackup = (ctx: Actor, passphrase: string) =>
  ctx.deps.system.createBackup({ passphrase, actorId: ctx.principal.id });

export const restoreBackup = (
  ctx: Actor,
  input: { data: string; passphrase: string; mode: 'merge' | 'replace'; dryRun: boolean },
) => ctx.deps.system.restoreBackup({ ...input, actorId: ctx.principal.id });

export const getMaintenance = (deps: ApiDeps) => deps.system.maintenance();

export const setMaintenance = (ctx: Actor, enabled: boolean) =>
  ctx.deps.system.setMaintenance({ enabled, actorId: ctx.principal.id });
