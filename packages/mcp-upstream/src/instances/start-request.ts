import {
  type PackageSpec,
  resolveTemplate,
  SandboxStartFailedError,
  TemplateError,
} from '@bastion-mcp/core';
import type { StartRequestInput } from '@bastion-mcp/sandbox';
import { templateContextFor } from '../connectors/remote';
import type { CallPrincipal, ResolvedCredential, ResolvedInstallation } from '../ports';

/**
 * The runner `/v1/start` request (8.3) from the installation's spec: arguments, environment and credential
 * injections resolved from value templates per user, the catalog version's lockfile, mirrors and the egress proxy.
 */

export type StartRequestSettings = {
  proxyUrl: string;
  npmRegistry?: string | undefined;
  pypiIndexUrl?: string | undefined;
};

export const buildStartRequest = (
  installation: ResolvedInstallation,
  principal: CallPrincipal,
  credential: ResolvedCredential,
  settings: StartRequestSettings,
): StartRequestInput => {
  const spec = installation.spec;
  if (spec.type !== 'package') throw new Error('not a package installation');
  const context = templateContextFor(installation, principal, credential);
  const resolve = (template: string): string => resolveTemplate(template, context);
  try {
    return assemble(spec, credential, resolve, settings);
  } catch (error) {
    if (error instanceof TemplateError) {
      throw new SandboxStartFailedError(`cannot resolve the server settings: ${error.message}`, {
        installation: installation.slug,
        phase: 'claiming',
      });
    }
    throw error;
  }
};

const assemble = (
  spec: PackageSpec,
  credential: ResolvedCredential,
  resolve: (template: string) => string,
  settings: StartRequestSettings,
): StartRequestInput => {
  const args: string[] = [];
  for (const argument of spec.packageArguments ?? []) {
    const value = resolve(argument.value);
    if (argument.type === 'named' && argument.name) args.push(argument.name, value);
    else args.push(value);
  }
  const env: Record<string, string> = {};
  for (const variable of spec.environmentVariables ?? []) {
    const raw = variable.value ?? variable.default;
    if (raw === undefined) continue;
    env[variable.name] = resolve(raw);
  }
  for (const injection of credential.injections) {
    if (injection.to === 'env') env[injection.name] = resolve(injection.value);
    else if (injection.to === 'arg') {
      const value = resolve(injection.value);
      const flagged = injection.flag === undefined ? [value] : [injection.flag, value];
      if (injection.position === undefined || injection.position >= args.length) {
        args.push(...flagged);
      } else {
        args.splice(injection.position, 0, ...flagged);
      }
    }
  }
  return {
    runtime: spec.runtime,
    identifier: spec.identifier,
    version: spec.version,
    ...(spec.bin === undefined ? {} : { bin: spec.bin }),
    ...(spec.lockfile === undefined ? {} : { lockfile: spec.lockfile }),
    allowInstallScripts: spec.allowInstallScripts,
    args,
    env,
    registry: {
      ...(settings.npmRegistry === undefined ? {} : { npm: settings.npmRegistry }),
      ...(settings.pypiIndexUrl === undefined ? {} : { pypi: settings.pypiIndexUrl }),
    },
    egress: { proxyUrl: settings.proxyUrl },
  };
};
