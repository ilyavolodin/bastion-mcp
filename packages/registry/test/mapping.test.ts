import { parseServerSpec } from '@bastion-mcp/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  availableRuntimes,
  deriveInstallForm,
  RegistryMappingError,
  sanitizeVariableName,
  serverJsonSchema,
  serverJsonToSpec,
} from '../src';
import * as fx from './fixtures/server-json';

const parse = (doc: unknown) => serverJsonSchema.parse(doc);

describe('11.6 mapping server.json to ServerSpec', () => {
  it('11.6 npm stdio package maps to PackageSpec with identifier, version and runtime', () => {
    const result = serverJsonToSpec(parse(fx.npmStdioSecrets));
    if (!result.installable || result.spec.type !== 'package')
      throw new Error('expected a package');
    expect(result.runtime).toBe('npm');
    expect(result.spec).toMatchObject({
      runtime: 'npm',
      identifier: '@acme/github-tools-mcp',
      version: '2.4.1',
    });
  });

  it('11.6 package arguments keep positional and named kinds with value templates', () => {
    const result = serverJsonToSpec(parse(fx.npmStdioSecrets));
    if (!result.installable || result.spec.type !== 'package')
      throw new Error('expected a package');
    expect(result.spec.packageArguments).toMatchObject([
      { type: 'named', name: '--org', value: '{{var.org}}', isRequired: true },
      { type: 'named', name: '--readonly', value: '' },
      { type: 'positional', value: 'all' },
    ]);
  });

  it('11.6 non-secret env vars become install-form variables, fixed values stay literal', () => {
    const result = serverJsonToSpec(parse(fx.npmStdioSecrets));
    if (!result.installable || result.spec.type !== 'package')
      throw new Error('expected a package');
    expect(result.spec.environmentVariables).toMatchObject([
      {
        name: 'GITHUB_API_URL',
        value: '{{var.GITHUB_API_URL}}',
        default: 'https://api.github.com',
        choices: ['https://api.github.com', 'https://github.example.com/api/v3'],
      },
      { name: 'LOG_LEVEL', value: 'info' },
    ]);
    expect(result.form.variables.map((v) => v.name)).toEqual(['org', 'GITHUB_API_URL']);
    expect(result.form.variables[1]).toMatchObject({
      required: false,
      default: 'https://api.github.com',
    });
  });

  it('11.6 secret env vars become userSecret fields injected as env (9.5)', () => {
    const result = serverJsonToSpec(parse(fx.npmStdioSecrets));
    if (!result.installable) throw new Error('expected installable');
    expect(result.spec.auth).toEqual({
      mode: 'userSecret',
      fields: [
        { name: 'GITHUB_TOKEN', label: 'GITHUB_TOKEN', description: 'Personal access token' },
      ],
      inject: [{ to: 'env', name: 'GITHUB_TOKEN', value: '{{secret.GITHUB_TOKEN}}' }],
    });
    expect(result.form.secrets.map((s) => s.name)).toEqual(['GITHUB_TOKEN']);
  });

  it('11.6 pypi stdio maps with runtime pypi and drops runtimeArguments with a warning', () => {
    const result = serverJsonToSpec(parse(fx.pypiStdio));
    if (!result.installable || result.spec.type !== 'package')
      throw new Error('expected a package');
    expect(result.spec).toMatchObject({
      runtime: 'pypi',
      identifier: 'postgres-inspector-mcp',
      version: '0.9.3',
    });
    expect(result.warnings.join(' ')).toMatch(/runtimeArguments/);
    expect(result.form.variables).toMatchObject([
      { name: 'dsn', required: true, description: 'Connection string' },
    ]);
  });

  it('11.6 remote with secret header maps to RemoteSpec with userSecret injected as a header', () => {
    const result = serverJsonToSpec(parse(fx.remoteWithHeaders));
    if (!result.installable || result.spec.type !== 'remote') throw new Error('expected a remote');
    expect(result.spec.url).toBe('https://mcp.atlassian.example/v1/mcp');
    expect(result.spec.transport).toBe('streamable-http');
    expect(result.spec.headers).toMatchObject([{ name: 'X-Client', value: 'bastion' }]);
    expect(result.spec.auth).toMatchObject({
      mode: 'userSecret',
      fields: [{ name: 'api_token' }],
      inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{secret.api_token}}' }],
    });
  });

  it('11.6 a secret header without placeholders uses the header name as the secret field', () => {
    const doc = parse({
      name: 'io.github.acme/keyed',
      description: 'd',
      version: '1.0.0',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://x.example/mcp',
          headers: [{ name: 'X-Api-Key', isSecret: true }],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable) throw new Error('expected installable');
    expect(result.spec.auth).toMatchObject({
      fields: [{ name: 'X_Api_Key' }],
      inject: [{ to: 'header', name: 'X-Api-Key', value: '{{secret.X_Api_Key}}' }],
    });
  });

  it('11.6 non-secret header without a value becomes an install-form variable', () => {
    const doc = parse({
      name: 'io.github.acme/orgheader',
      description: 'd',
      version: '1.0.0',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://x.example/mcp',
          headers: [{ name: 'X-Org', isRequired: true }],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable || result.spec.type !== 'remote') throw new Error('expected a remote');
    expect(result.spec.headers).toMatchObject([{ name: 'X-Org', value: '{{var.X_Org}}' }]);
    expect(result.form.variables).toMatchObject([{ name: 'X_Org', required: true }]);
    expect(result.spec.auth).toEqual({ mode: 'none' });
  });

  it('11.6 remote URL variables map to RemoteSpec variables and the install form', () => {
    const result = serverJsonToSpec(parse(fx.remoteWithUrlVariables));
    if (!result.installable || result.spec.type !== 'remote') throw new Error('expected a remote');
    expect(result.spec.transport).toBe('sse');
    expect(result.spec.url).toBe('https://{{var.tenant}}.docs.example.com/{{var.region}}/mcp');
    expect(result.spec.variables).toMatchObject({
      tenant: { name: 'tenant', isRequired: true },
      region: { name: 'region', default: 'eu', choices: ['eu', 'us'] },
    });
    expect(result.form.variables).toMatchObject([
      { name: 'tenant', required: true, description: 'Tenant subdomain' },
      { name: 'region', required: false, default: 'eu' },
    ]);
  });

  it('11.6 oci is shown as unsupported runtime and not installable', () => {
    const result = serverJsonToSpec(parse(fx.ociOnly));
    expect(result).toMatchObject({
      installable: false,
      reason: 'unsupported runtime',
      registryTypes: ['oci'],
    });
  });

  it('11.6 nuget and mcpb are unsupported runtimes', () => {
    const result = serverJsonToSpec(parse(fx.nugetAndMcpb));
    expect(result).toMatchObject({ installable: false, reason: 'unsupported runtime' });
    expect(result.installable ? [] : result.registryTypes).toEqual(['nuget', 'mcpb']);
  });

  it('11.6 an npm package that is not stdio is not installable as a package', () => {
    const result = serverJsonToSpec(parse(fx.packageOnlyStreamableTransport));
    expect(result).toMatchObject({ installable: false, reason: 'unsupported runtime' });
  });

  it('11.6 an entry with neither packages nor remotes has no runtime', () => {
    const result = serverJsonToSpec(
      parse({ name: 'io.github.acme/empty', version: '1.0.0', description: '' }),
    );
    expect(result).toMatchObject({ installable: false, reason: 'no runtime' });
  });

  it('11.6 remote is preferred when both exist and the importer can switch', () => {
    const doc = parse(fx.bothRemoteAndPackage);
    const preferred = serverJsonToSpec(doc);
    if (!preferred.installable) throw new Error('expected installable');
    expect(preferred.spec.type).toBe('remote');
    expect(preferred.alternatives).toEqual(['npm']);

    const switched = serverJsonToSpec(doc, { prefer: 'package' });
    if (!switched.installable) throw new Error('expected installable');
    expect(switched.spec.type).toBe('package');
    expect(switched.alternatives).toEqual(['remote']);
  });

  it('11.6 prefer remote falls back to the package, prefer package falls back to the remote', () => {
    const pkgOnly = serverJsonToSpec(parse(fx.deprecatedServer), { prefer: 'remote' });
    expect(pkgOnly.installable && pkgOnly.spec.type).toBe('package');
    const remoteOnly = serverJsonToSpec(parse(fx.remoteWithHeaders), { prefer: 'package' });
    expect(remoteOnly.installable && remoteOnly.spec.type).toBe('remote');
  });

  it('8.7 a version range is rejected with a clear error', () => {
    expect(() => serverJsonToSpec(parse(fx.rangeVersion))).toThrow(RegistryMappingError);
    expect(() => serverJsonToSpec(parse(fx.rangeVersion))).toThrow(/exact/);
  });

  it('8.7 the literal "latest" is rejected as a version', () => {
    const doc = parse({
      name: 'io.github.acme/latest',
      description: 'd',
      version: '1.0.0',
      packages: [
        { registryType: 'npm', identifier: 'x', version: 'latest', transport: { type: 'stdio' } },
      ],
    });
    expect(() => serverJsonToSpec(doc)).toThrow(/exact/);
  });

  it('11.6 every installable fixture output validates with parseServerSpec', () => {
    for (const doc of [
      fx.npmStdioSecrets,
      fx.pypiStdio,
      fx.remoteWithHeaders,
      fx.remoteWithUrlVariables,
      fx.bothRemoteAndPackage,
      fx.deprecatedServer,
    ]) {
      for (const prefer of ['remote', 'package'] as const) {
        const result = serverJsonToSpec(parse(doc), { prefer });
        if (result.installable) expect(parseServerSpec(result.spec)).toEqual(result.spec);
      }
    }
  });

  it('11.6 secret positional and named arguments are injected as arg', () => {
    const doc = parse({
      name: 'io.github.acme/argsecret',
      description: 'd',
      version: '1.0.0',
      packages: [
        {
          registryType: 'npm',
          identifier: 'argsecret-mcp',
          version: '1.0.0',
          transport: { type: 'stdio' },
          packageArguments: [
            { type: 'positional', valueHint: 'token', isSecret: true },
            { type: 'named', name: '--key', isSecret: true },
          ],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable) throw new Error('expected installable');
    expect(result.spec.auth).toMatchObject({
      mode: 'userSecret',
      inject: [
        { to: 'arg', position: 0, value: '{{secret.token}}' },
        { to: 'arg', flag: '--key', value: '{{secret.key}}' },
      ],
    });
  });

  it('11.6 argument values with placeholders and variables are converted', () => {
    const doc = parse({
      name: 'io.github.acme/argvars',
      description: 'd',
      version: '1.0.0',
      packages: [
        {
          registryType: 'pypi',
          identifier: 'argvars',
          version: '1.0',
          transport: { type: 'stdio' },
          packageArguments: [
            {
              type: 'named',
              name: '--url',
              value: 'https://{host}/x',
              variables: { host: { description: 'Host' } },
            },
            { type: 'positional', isRequired: true },
            { type: 'named', name: '--opt', valueHint: 'opt' },
          ],
          environmentVariables: [
            { name: 'AUTH', value: 'Token {tok}', isSecret: true, variables: { tok: {} } },
          ],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable || result.spec.type !== 'package') throw new Error('expected package');
    expect(result.spec.packageArguments).toMatchObject([
      { name: '--url', value: 'https://{{var.host}}/x' },
      { type: 'positional', value: '{{var.arg1}}' },
    ]);
    expect(result.spec.auth).toMatchObject({
      inject: [{ to: 'env', name: 'AUTH', value: 'Token {{secret.tok}}' }],
    });
  });

  it('11.6 env value with non-secret placeholder stays an env variable entry', () => {
    const doc = parse({
      name: 'io.github.acme/envph',
      description: 'd',
      version: '1.0.0',
      packages: [
        {
          registryType: 'npm',
          identifier: 'envph',
          version: '1.0.0',
          transport: { type: 'stdio' },
          environmentVariables: [
            { name: 'BASE', value: 'https://{h}/', variables: { h: { default: 'a.example' } } },
          ],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable || result.spec.type !== 'package') throw new Error('expected package');
    expect(result.spec.environmentVariables).toMatchObject([
      { name: 'BASE', value: 'https://{{var.h}}/' },
    ]);
  });

  it('11.6 a secret in the URL is flagged', () => {
    const doc = parse({
      name: 'io.github.acme/urlsecret',
      description: 'd',
      version: '1.0.0',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://x.example/{key}/mcp',
          variables: { key: { isSecret: true } },
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable) throw new Error('expected installable');
    expect(result.warnings.join(' ')).toMatch(/secret is embedded/);
  });
});

describe('11.6 availableRuntimes and deriveInstallForm', () => {
  it('11.6 lists remote and supported package runtimes only', () => {
    expect(availableRuntimes(parse(fx.bothRemoteAndPackage))).toEqual(['remote', 'npm']);
    expect(availableRuntimes(parse(fx.ociOnly))).toEqual([]);
  });

  it('11.4 deriveInstallForm of a plain spec is empty', () => {
    expect(
      deriveInstallForm(
        parseServerSpec({
          type: 'remote',
          transport: 'streamable-http',
          url: 'https://x.example/mcp',
          auth: { mode: 'none' },
        }),
      ),
    ).toEqual({
      variables: [],
      secrets: [],
    });
  });
});

describe('property: mapping', () => {
  it('11.6 sanitized names are always valid template references', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (raw) => {
        expect(sanitizeVariableName(raw)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }),
    );
  });

  it('11.6 arbitrary env var names map to a spec that parseServerSpec accepts', () => {
    const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/);
    fc.assert(
      fc.property(
        fc.array(fc.record({ name, isSecret: fc.boolean(), isRequired: fc.boolean() }), {
          maxLength: 6,
        }),
        (envs) => {
          const unique = [...new Map(envs.map((e) => [e.name, e])).values()];
          const doc = parse({
            name: 'io.github.acme/prop',
            description: 'd',
            version: '1.0.0',
            packages: [
              {
                registryType: 'npm',
                identifier: 'p',
                version: '1.2.3',
                transport: { type: 'stdio' },
                environmentVariables: unique,
              },
            ],
          });
          const result = serverJsonToSpec(doc);
          if (!result.installable) throw new Error('expected installable');
          parseServerSpec(result.spec);
          const secretCount = unique.filter((e) => e.isSecret).length;
          expect(result.form.secrets.length).toBe(
            new Set(unique.filter((e) => e.isSecret).map((e) => sanitizeVariableName(e.name))).size,
          );
          expect(result.form.secrets.length).toBeLessThanOrEqual(secretCount);
        },
      ),
    );
  });
});

describe('11.6 variable name collisions', () => {
  const remoteWith = (url: string, variables: Record<string, unknown>) =>
    serverJsonSchema.parse({
      name: 'io.github.acme/collide',
      description: 'd',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url, variables }],
    });

  it('11.6 placeholders a-b and a_b stay two distinct variables, deterministically', () => {
    const doc = remoteWith('https://x.example/{a-b}/{a_b}', {
      'a-b': { description: 'dash' },
      a_b: { description: 'underscore' },
    });
    const first = serverJsonToSpec(doc);
    const second = serverJsonToSpec(doc);
    if (!first.installable || first.spec.type !== 'remote') throw new Error('expected remote');
    expect(first.spec.url).toBe('https://x.example/{{var.a_b}}/{{var.a_b_2}}');
    expect(first.form.variables.map((v) => v.description)).toEqual(['dash', 'underscore']);
    expect(second).toEqual(first);
  });

  it('11.6 secret env vars A-B and A_B stay two distinct secrets', () => {
    const doc = serverJsonSchema.parse({
      name: 'io.github.acme/collide',
      description: 'd',
      version: '1.0.0',
      packages: [
        {
          registryType: 'npm',
          identifier: 'p',
          version: '1.2.3',
          transport: { type: 'stdio' },
          environmentVariables: [
            { name: 'A-B', isSecret: true },
            { name: 'A_B', isSecret: true },
          ],
        },
      ],
    });
    const result = serverJsonToSpec(doc);
    if (!result.installable) throw new Error('expected installable');
    expect(result.form.secrets.map((s) => s.name)).toEqual(['A_B', 'A_B_2']);
  });
});
