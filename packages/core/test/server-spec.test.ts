import { describe, expect, it } from 'vitest';
import { parseServerSpec, serverSpecSchema, serverSpecTemplates } from '../src/server-spec';

const pkg = {
  type: 'package',
  runtime: 'npm',
  identifier: '@modelcontextprotocol/server-github',
  version: '1.2.3',
  auth: { mode: 'none' },
  egress: { allow: ['api.github.com'] },
} as const;

const remote = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/{region}',
  auth: {
    mode: 'orgSecret',
    inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{secret.KEY}}' }],
  },
} as const;

describe('8.1 ServerSpec', () => {
  it('parses a package spec and applies documented defaults', () => {
    const spec = parseServerSpec(pkg);
    expect(spec).toMatchObject({
      protocol: 'legacy',
      size: 'small',
      allowInstallScripts: false,
      idleTimeoutMinutes: 15,
      instanceScope: 'perUser',
      workspace: { persistent: false, sizeMiB: 512 },
    });
  });

  it('parses a remote spec', () => {
    expect(parseServerSpec(remote).type).toBe('remote');
  });

  it.each(['^1.2.3', '~1.2', 'latest', '1.x', '>=1', '*', ''])(
    '8.7 rejects version %j (exact versions only)',
    (version) => {
      expect(serverSpecSchema.safeParse({ ...pkg, version }).success).toBe(false);
    },
  );

  it('accepts exact prerelease and PEP 440 style versions', () => {
    expect(serverSpecSchema.safeParse({ ...pkg, version: '1.2.3-beta.1' }).success).toBe(true);
    expect(
      serverSpecSchema.safeParse({
        ...pkg,
        runtime: 'pypi',
        identifier: 'mcp-server-fetch',
        version: '0.6.2',
      }).success,
    ).toBe(true);
  });

  it('bounds idleTimeoutMinutes to 1..1440', () => {
    expect(serverSpecSchema.safeParse({ ...pkg, idleTimeoutMinutes: 0 }).success).toBe(false);
    expect(serverSpecSchema.safeParse({ ...pkg, idleTimeoutMinutes: 1441 }).success).toBe(false);
  });

  it('8.6 shared instances need auth none or orgSecret', () => {
    expect(serverSpecSchema.safeParse({ ...pkg, instanceScope: 'shared' }).success).toBe(true);
    expect(
      serverSpecSchema.safeParse({
        ...pkg,
        instanceScope: 'shared',
        auth: { mode: 'userSecret', fields: [{ name: 'T', label: 'Token' }], inject: [] },
      }).success,
    ).toBe(false);
  });

  it('8.6 shared instances reject {{user.*}} and {{oauth.*}} templates', () => {
    const res = serverSpecSchema.safeParse({
      ...pkg,
      instanceScope: 'shared',
      environmentVariables: [{ name: 'WHO', value: '{{user.email}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('8.1 unknown template references fail validation when the entry is saved', () => {
    const res = serverSpecSchema.safeParse({
      ...pkg,
      environmentVariables: [{ name: 'X', value: '{{nope.x}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('collects every template string in a spec', () => {
    const spec = parseServerSpec({
      ...pkg,
      packageArguments: [{ type: 'named', name: '--org', value: '{{var.ORG}}' }],
      environmentVariables: [{ name: 'TOKEN', value: '{{secret.T}}' }],
    });
    expect(serverSpecTemplates(spec).sort()).toEqual(['{{secret.T}}', '{{var.ORG}}']);
  });

  it('9.5 validates every auth mode', () => {
    for (const auth of [
      { mode: 'none' },
      { mode: 'orgSecret', inject: [] },
      { mode: 'userSecret', fields: [{ name: 'K', label: 'Key' }], inject: [] },
      { mode: 'oauth', client: { registration: 'auto' } },
      { mode: 'enterpriseManaged', idpConnectionId: '0192d3a0-0000-7000-8000-000000000000' },
      {
        mode: 'tokenExchange',
        idpConnectionId: '0192d3a0-0000-7000-8000-000000000000',
        flavor: 'rfc8693',
        audience: 'api://x',
      },
    ]) {
      expect(serverSpecSchema.safeParse({ ...remote, auth }).success, JSON.stringify(auth)).toBe(
        true,
      );
    }
    expect(serverSpecSchema.safeParse({ ...remote, auth: { mode: 'magic' } }).success).toBe(false);
  });

  it('rejects egress entries that are not host, *.suffix or CIDR', () => {
    expect(serverSpecSchema.safeParse({ ...pkg, egress: { allow: ['not a host'] } }).success).toBe(
      false,
    );
  });
});
