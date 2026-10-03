import { describe, expect, it } from 'vitest';
import {
  buildPolicyTest,
  CIDR,
  mappingFormSchema,
  mappingToBody,
  oauthClientFormSchema,
  oauthClientToBody,
  parseJwks,
  serviceAccountFormSchema,
  serviceAccountToBody,
  teamFormSchema,
  teamToBody,
  toMarkers,
} from './forms';

describe('team form (10.1)', () => {
  it('needs a name and a valid URL name', () => {
    expect(teamFormSchema.safeParse({ displayName: '', slug: 'ok' }).success).toBe(false);
    expect(teamFormSchema.safeParse({ displayName: 'Platform', slug: 'Not Valid' }).success).toBe(
      false,
    );
    expect(teamFormSchema.safeParse({ displayName: 'Platform', slug: 'platform' }).success).toBe(
      true,
    );
  });

  it('sends the IdP group only when one is named', () => {
    expect(teamToBody({ displayName: 'Platform', slug: 'platform' })).toEqual({
      slug: 'platform',
      displayName: 'Platform',
    });
    expect(teamToBody({ displayName: 'P', slug: 'pp', idpGroup: 'eng' })).toMatchObject({
      idpGroup: 'eng',
    });
  });
});

describe('service account form (9.3)', () => {
  const jwk = { kty: 'RSA', n: 'abc', e: 'AQAB' };

  it('parseJwks takes a JWKS document or a plain array and refuses everything else', () => {
    expect(parseJwks(JSON.stringify({ keys: [jwk] }))).toEqual([jwk]);
    expect(parseJwks(JSON.stringify([jwk]))).toEqual([jwk]);
    expect(parseJwks(JSON.stringify({ keys: [] }))).toBeNull();
    expect(parseJwks('not json')).toBeNull();
    expect(parseJwks('null')).toBeNull();
    expect(parseJwks(JSON.stringify([{ kty: 1 }]))).toBeNull();
  });

  const base = { displayName: 'CI', slug: 'ci', teamId: 't1' };

  it('a private-key account needs public keys; a secret one does not', () => {
    const bad = serviceAccountFormSchema.safeParse({
      ...base,
      authMethod: 'private_key_jwt',
      jwks: '',
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(['jwks']);
    expect(
      serviceAccountFormSchema.safeParse({ ...base, authMethod: 'client_secret_basic' }).success,
    ).toBe(true);
  });

  it('needs a team', () => {
    expect(
      serviceAccountFormSchema.safeParse({ ...base, teamId: '', authMethod: 'client_secret_basic' })
        .success,
    ).toBe(false);
  });

  it('builds the body, with the keys only for a private-key account', () => {
    expect(serviceAccountToBody({ ...base, authMethod: 'client_secret_basic' })).toEqual({
      teamId: 't1',
      slug: 'ci',
      displayName: 'CI',
      authMethod: 'client_secret_basic',
    });
    expect(
      serviceAccountToBody({
        ...base,
        authMethod: 'private_key_jwt',
        jwks: JSON.stringify({ keys: [jwk] }),
      }),
    ).toMatchObject({ authMethod: 'private_key_jwt', jwks: [jwk] });
  });
});

describe('IdP group mapping form (10.1)', () => {
  const base = {
    idpConnectionId: '',
    groupPattern: 'eng-*',
    target: 'role' as const,
    orgRole: 'auditor' as const,
    teamId: '',
    teamRole: 'member' as const,
    priority: '10',
  };

  it('a team target needs a team; the priority is a whole number from 0 to 100000', () => {
    const noTeam = mappingFormSchema.safeParse({ ...base, target: 'team' });
    expect(noTeam.success).toBe(false);
    if (!noTeam.success) expect(noTeam.error.issues[0]?.path).toEqual(['teamId']);
    expect(mappingFormSchema.safeParse({ ...base, priority: '1.5' }).success).toBe(false);
    expect(mappingFormSchema.safeParse({ ...base, priority: '100001' }).success).toBe(false);
    expect(mappingFormSchema.safeParse({ ...base, groupPattern: ' ' }).success).toBe(false);
  });

  it('maps to a role, to a team, or to a team created from the group', () => {
    const parse = (v: object) => mappingFormSchema.parse({ ...base, ...v });
    expect(mappingToBody(parse({}))).toEqual({
      idpConnectionId: null,
      groupPattern: 'eng-*',
      mapsTo: { orgRole: 'auditor' },
      priority: 10,
    });
    expect(
      mappingToBody(parse({ target: 'team', teamId: 't1', teamRole: 'manager' })).mapsTo,
    ).toEqual({ teamId: 't1', teamRole: 'manager' });
    expect(mappingToBody(parse({ target: 'createTeam', idpConnectionId: 'c1' }))).toMatchObject({
      idpConnectionId: 'c1',
      mapsTo: { createTeam: true, teamRole: 'member' },
    });
  });
});

describe('OAuth client form (9.4)', () => {
  it('needs a client id and passes the flags through', () => {
    expect(
      oauthClientFormSchema.safeParse({ clientId: ' ', preApproved: false, blocked: false })
        .success,
    ).toBe(false);
    const ok = oauthClientFormSchema.parse({ clientId: ' c ', preApproved: true, blocked: false });
    expect(oauthClientToBody(ok)).toEqual({ clientId: 'c', preApproved: true, blocked: false });
  });
});

describe('policy tests and markers (10.3)', () => {
  it('CIDR accepts an address with or without a prefix length', () => {
    for (const v of ['10.0.0.0/8', '192.168.1.2', '::1', 'fe80::/10']) {
      expect(CIDR.test(v)).toBe(true);
    }
    for (const v of ['', 'host.example', '10.0.0.0/', '10 0 0 0']) {
      expect(CIDR.test(v)).toBe(false);
    }
  });

  const input = {
    name: 'n',
    expect: 'deny' as const,
    action: 'callTool' as const,
    role: 'member' as const,
    teamId: '',
    teamRole: 'member' as const,
    installationId: 'i1',
    catalogEntryId: 'c1',
    toolName: 'post',
  };

  it('buildPolicyTest asks about a tool, a prompt or a resource by the action', () => {
    const resourceOf = (action: 'callTool' | 'getPrompt' | 'readResource') =>
      buildPolicyTest({ ...input, action }).request.resource;
    expect(resourceOf('callTool')).toEqual({
      type: 'Tool',
      installation: { id: 'i1', catalogEntryId: 'c1' },
      name: 'post',
    });
    expect(resourceOf('getPrompt')).toMatchObject({ type: 'Prompt', name: 'post' });
    expect(resourceOf('readResource')).toMatchObject({ type: 'Resource', uri: 'post' });
  });

  it('puts the person on a team only when one is chosen', () => {
    expect(buildPolicyTest(input).request.principal).toEqual({
      kind: 'user',
      id: 'test-user',
      role: 'member',
    });
    expect(
      buildPolicyTest({ ...input, teamId: 't1', teamRole: 'manager' }).request.principal,
    ).toMatchObject({ teams: [{ id: 't1', role: 'manager' }] });
  });

  it('toMarkers reads the line a Cedar message points at, line 1 otherwise', () => {
    expect(toMarkers(['parse error at line 3', 'unknown', 'Line 12: bad'])).toEqual([
      { line: 3, message: 'parse error at line 3' },
      { line: 1, message: 'unknown' },
      { line: 12, message: 'Line 12: bad' },
    ]);
  });
});
