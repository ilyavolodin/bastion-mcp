import {
  BastionError,
  type Injection,
  resolveTemplate,
  type TemplateContext,
  TemplateError,
} from '@bastion-mcp/core';
import { UPSTREAM_REFRESH_WINDOW_S } from '../constants';

/** Invalid auth configuration of an installation or IdP connection (not the user's fault). */
export class OAuthConfigError extends BastionError {
  constructor(message: string) {
    super('UPSTREAM_AUTH_MISCONFIGURED', message, { httpStatus: 500 });
  }
}

export type ResolvedInjection = Injection;

/** Remote servers default to `Authorization: Bearer <token>` (9.5); packages have no default. */
export const DEFAULT_REMOTE_INJECTION: Injection = {
  to: 'header',
  name: 'Authorization',
  value: 'Bearer {{oauth.accessToken}}',
};

/** Resolves inject templates (`{{oauth.accessToken}}`, `{{secret.NAME}}`, ...) into concrete values. */
export const buildInjections = (input: {
  inject: readonly Injection[] | undefined;
  kind: 'remote' | 'package';
  context: TemplateContext;
}): ResolvedInjection[] => {
  const rules =
    input.inject && input.inject.length > 0
      ? input.inject
      : input.kind === 'remote'
        ? [DEFAULT_REMOTE_INJECTION]
        : [];
  if (rules.length === 0) {
    throw new OAuthConfigError('packages must declare where the credential is injected (9.5)');
  }
  try {
    return rules.map((rule) => ({ ...rule, value: resolveTemplate(rule.value, input.context) }));
  } catch (error) {
    if (error instanceof TemplateError) throw new OAuthConfigError(error.message);
    throw error;
  }
};

export type PackageTokenDecision = { action: 'keep' } | { action: 'refresh-and-restart' };

/**
 * Packages (9.6): the token is injected at start. When a call arrives and the injected token expires
 * within 5 minutes, Bastion refreshes, waits for in-flight calls and restarts the instance.
 */
export const decidePackageTokenAction = (input: {
  /** Epoch milliseconds, null when the token does not expire. */
  injectedExpiresAt: number | null;
  nowMs: number;
  windowSeconds?: number;
}): PackageTokenDecision => {
  if (input.injectedExpiresAt === null) return { action: 'keep' };
  const window = (input.windowSeconds ?? UPSTREAM_REFRESH_WINDOW_S) * 1000;
  return input.injectedExpiresAt - input.nowMs <= window
    ? { action: 'refresh-and-restart' }
    : { action: 'keep' };
};
