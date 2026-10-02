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
