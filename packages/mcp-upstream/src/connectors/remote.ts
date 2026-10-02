import {
  type RemoteSpec,
  resolveTemplate,
  type TemplateContext,
  TemplateError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import {
  assertSafeRemoteUrl,
  type Resolver,
  type SafeRemoteUrl,
  UnsafeRemoteUrlError,
} from '@bastion-mcp/sandbox';
import type { FetchLike } from '@modelcontextprotocol/client';
import { type Agent, fetch as undiciFetch } from 'undici';
import type { CallPrincipal, Logger, ResolvedCredential, ResolvedInstallation } from '../ports';
import type { TlsMaterial } from './agent';
import type { CapTracker } from './caps';
import { traceHeaders } from './identity';
import { traceStorage } from './trace';

/** Remote connector plumbing (8.9): templates, SSRF check, TLS secrets and the pinned `fetch`. */

/** Port: loads the PEM text behind `tls.caBundleSecret` and `tls.clientCertSecret` (secrets package adapter). */
export interface TlsSecretResolver {
  resolve(
    secretName: string,
    principal: CallPrincipal,
    installation: ResolvedInstallation,
  ): Promise<string>;
}

export type RemoteSettings = {
  /** `BASTION_PRIVATE_UPSTREAM_CIDRS`, honored for admin-authored entries only (8.9). */
  privateCidrs: readonly string[];
  /** `BASTION_INSECURE_UPSTREAM_HOSTS` (development only). */
  insecureHosts: readonly string[];
  resolver?: Resolver | undefined;
  tls?: TlsSecretResolver | undefined;
  logger?: Logger | undefined;
};

export type RemoteTarget = {
  url: URL;
  safe: SafeRemoteUrl;
  /** Static headers: the spec's header templates plus credential injections. */
  headers: Record<string, string>;
  tls: TlsMaterial;
};

export const templateContextFor = (
  installation: ResolvedInstallation,
  principal: CallPrincipal,
  credential: ResolvedCredential,
): TemplateContext => {
  const spec = installation.spec;
  const defaults: Record<string, string> = {};
  if (spec.type === 'remote') {
    for (const [name, variable] of Object.entries(spec.variables ?? {})) {
      if (variable.default !== undefined) defaults[name] = variable.default;
    }
  } else {
    for (const variable of spec.environmentVariables ?? []) {
      if (variable.default !== undefined) defaults[variable.name] = variable.default;
    }
  }
  return {
    var: { ...defaults, ...installation.variables },
    user: {
      id: principal.userId,
      ...(principal.email === undefined ? {} : { email: principal.email }),
      teams: principal.teams ?? [],
    },
    ...(credential.templateContext?.secret ? { secret: credential.templateContext.secret } : {}),
    ...(credential.templateContext?.oauth ? { oauth: credential.templateContext.oauth } : {}),
    sandbox: { workspace: '/workspace' },
  };
};

/** Resolves URL variables and headers per user at connect time, then runs the SSRF and HTTPS checks (8.9). */
export const resolveRemoteTarget = async (
  installation: ResolvedInstallation,
  principal: CallPrincipal,
  credential: ResolvedCredential,
  settings: RemoteSettings,
): Promise<RemoteTarget> => {
  const spec = installation.spec;
  if (spec.type !== 'remote') throw new Error('not a remote installation');
  const context = templateContextFor(installation, principal, credential);
  let rawUrl: string;
  const headers: Record<string, string> = {};
  try {
    rawUrl = resolveTemplate(spec.url, context);
    for (const header of spec.headers ?? []) {
      if (header.value === undefined) continue;
      headers[header.name] = resolveTemplate(header.value, context);
    }
    for (const injection of credential.injections) {
      if (injection.to === 'header') {
        headers[injection.name] = resolveTemplate(injection.value, context);
      }
    }
  } catch (error) {
    if (error instanceof TemplateError) {
      throw new UpstreamUnavailableError(
        `cannot resolve the connection settings: ${error.message}`,
        { installation: installation.slug },
      );
    }
    throw error;
  }
  let safe: SafeRemoteUrl;
  try {
    safe = await assertSafeRemoteUrl(rawUrl, {
      privateCidrsAllowed: installation.origin === 'admin' ? settings.privateCidrs : [],
      insecureHosts: settings.insecureHosts,
      ...(settings.resolver ? { resolver: settings.resolver } : {}),
    });
  } catch (error) {
    if (error instanceof UnsafeRemoteUrlError) {
      throw new UpstreamUnavailableError(error.message, { installation: installation.slug }, error);
    }
    throw error;
  }
  return { url: safe.url, safe, headers, tls: await loadTls(spec, installation, principal, settings) };
};

const loadTls = async (
  spec: RemoteSpec,
  installation: ResolvedInstallation,
  principal: CallPrincipal,
  settings: RemoteSettings,
): Promise<TlsMaterial> => {
  if (!spec.tls || (!spec.tls.caBundleSecret && !spec.tls.clientCertSecret)) return {};
  if (!settings.tls) {
    throw new UpstreamUnavailableError(
      'custom TLS material is configured but no secret resolver exists',
      { installation: installation.slug },
    );
  }
  const material: TlsMaterial = {};
  if (spec.tls.caBundleSecret) {
    material.ca = await settings.tls.resolve(spec.tls.caBundleSecret, principal, installation);
  }
  if (spec.tls.clientCertSecret) {
    const pem = await settings.tls.resolve(spec.tls.clientCertSecret, principal, installation);
    material.cert = pem;
    material.key = pem;
  }
  return material;
};

/**
 * The `fetch` handed to the SDK transports: pinned `undici` agent, static headers, per-request trace headers and
 * the response caps.
 */
export const createRemoteFetch = (options: {
  agent: Agent;
  headers: Record<string, string>;
  caps: CapTracker;
}): FetchLike => {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(options.headers)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    const trace = traceStorage.getStore();
    if (trace) for (const [name, value] of Object.entries(traceHeaders(trace))) headers.set(name, value);
    const response = await undiciFetch(input as never, {
      ...(init as object),
      headers,
      dispatcher: options.agent,
    } as never);
    return options.caps.wrap(response as unknown as Response);
  };
};
