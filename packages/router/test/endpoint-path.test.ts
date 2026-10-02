import { describe, expect, it } from 'vitest';
import {
  assertAudienceAccepted,
  assertInstallationSlugAvailable,
  effectiveSlug,
  isAudienceAccepted,
  parseEndpointPath,
  parseProtectedResourcePath,
  protectedResourceMetadata,
  resolveEndpointDefinition,
} from '../src/endpoint-path';
import { installation } from './helpers';

describe('7.1 endpoint paths', () => {
  it('7.1 parses the four endpoint shapes', () => {
    expect(parseEndpointPath('/mcp')).toEqual({ kind: 'default' });
    expect(parseEndpointPath('/mcp/')).toEqual({ kind: 'default' });
    expect(parseEndpointPath('/mcp/e/work')).toEqual({ kind: 'named', slug: 'work' });
    expect(parseEndpointPath('/mcp/i/github')).toEqual({ kind: 'installation', slug: 'github' });
    expect(parseEndpointPath('/mcp/c/github')).toEqual({ kind: 'catalog', slug: 'github' });
  });

  it('7.1 rejects malformed slugs and unknown paths', () => {
    for (const p of [
      '/mcp/e/Work',
      '/mcp/e/a',
      '/mcp/e/a_b',
      '/mcp/e/../x',
      '/mcp/x/foo',
      '/mcp/e',
      '/mcp/e/foo/bar',
      '/other',
      'mcp',
      `/mcp/i/${'a'.repeat(82)}`,
    ]) {
      expect(parseEndpointPath(p)).toBeNull();
    }
  });

  it('7.1 protected resource metadata is served per endpoint with its exact URL as resource', () => {
    const o = {
      baseUrl: 'https://b.example.com/',
      authorizationServers: ['https://b.example.com'],
    };
    expect(
      protectedResourceMetadata('/.well-known/oauth-protected-resource/mcp', o)?.resource,
    ).toBe('https://b.example.com/mcp');
    expect(
      protectedResourceMetadata('/.well-known/oauth-protected-resource/mcp/e/work', {
        ...o,
        scopesSupported: ['mcp'],
      }),
    ).toMatchObject({ resource: 'https://b.example.com/mcp/e/work', scopes_supported: ['mcp'] });
    expect(
      protectedResourceMetadata('/.well-known/oauth-protected-resource/mcp/i/gh', o)?.resource,
    ).toBe('https://b.example.com/mcp/i/gh');
    expect(protectedResourceMetadata('/.well-known/oauth-protected-resource/other', o)).toBeNull();
    expect(parseProtectedResourcePath('/x')).toBeNull();
  });

  it('7.1 workers accept aud https://<host>/mcp or a path prefix of the request URL', () => {
    const url = 'https://b.example.com/mcp/e/work';
    expect(isAudienceAccepted('https://b.example.com/mcp', url)).toBe(true);
    expect(isAudienceAccepted('https://b.example.com/mcp/e/work', url)).toBe(true);
    expect(isAudienceAccepted(['x', 'https://b.example.com/mcp/'], url)).toBe(true);
    expect(isAudienceAccepted('https://b.example.com/mcp/e/other', url)).toBe(false);
    expect(isAudienceAccepted('https://b.example.com/mcp/e/wor', url)).toBe(false);
    expect(isAudienceAccepted('https://evil.example.com/mcp', url)).toBe(false);
    expect(isAudienceAccepted('https://b.example.com/', url)).toBe(false);
    expect(isAudienceAccepted('https://b.example.com/mcp?x=1', url)).toBe(false);
    expect(isAudienceAccepted('https://b.example.com/mcp', 'not a url')).toBe(false);
    expect(() => assertAudienceAccepted('https://evil.example.com/mcp', url)).toThrow(/audience/);
    expect(() => assertAudienceAccepted('https://b.example.com/mcp', url)).not.toThrow();
  });

  it('7.1 a team installation effective slug is {teamSlug}-{slug}', () => {
    expect(effectiveSlug(installation({ id: 'a', slug: 'github' }))).toBe('github');
    expect(
      effectiveSlug(
        installation({ id: 'a', slug: 'github', owner: { kind: 'team', id: 't', slug: 'eng' } }),
      ),
    ).toBe('eng-github');
  });

  it('7.1 creating a user installation fails when its slug equals a visible effective slug', () => {
    const visible = [
      installation({ id: 'a', slug: 'github' }),
      installation({ id: 'b', slug: 'jira', owner: { kind: 'team', id: 't', slug: 'eng' } }),
    ];
    expect(() => assertInstallationSlugAvailable('github', visible)).toThrow(/already used/);
    expect(() => assertInstallationSlugAvailable('eng-jira', visible)).toThrow(/already used/);
    expect(() => assertInstallationSlugAvailable('jira', visible)).not.toThrow();
  });

  it('7.1 resolves paths to endpoint definitions; /mcp/i/{slug} means the caller own installation', () => {
    const installations = [
      installation({ id: 'a', slug: 'github', catalogSlug: 'gh-entry' }),
      installation({ id: 'b', slug: 'jira', owner: { kind: 'team', id: 't', slug: 'eng' } }),
    ];
    const named = [
      {
        id: 'e1',
        kind: 'named' as const,
        slug: 'work',
        installationIds: ['a'],
        prefixMode: 'always' as const,
      },
    ];
    const data = { installations, namedEndpoints: named };
    expect(resolveEndpointDefinition({ kind: 'default' }, data)).toMatchObject({
      kind: 'default',
      prefixMode: 'always',
    });
    expect(resolveEndpointDefinition({ kind: 'named', slug: 'work' }, data)?.id).toBe('e1');
    expect(resolveEndpointDefinition({ kind: 'named', slug: 'nope' }, data)).toBeNull();
    expect(resolveEndpointDefinition({ kind: 'installation', slug: 'github' }, data)).toMatchObject(
      {
        installationIds: ['a'],
      },
    );
    expect(
      resolveEndpointDefinition({ kind: 'installation', slug: 'eng-jira' }, data),
    ).toMatchObject({
      installationIds: ['b'],
    });
    expect(resolveEndpointDefinition({ kind: 'installation', slug: 'jira' }, data)).toBeNull();
    expect(resolveEndpointDefinition({ kind: 'catalog', slug: 'gh-entry' }, data)).toMatchObject({
      kind: 'catalog',
      installationIds: ['a'],
    });
    expect(resolveEndpointDefinition({ kind: 'catalog', slug: 'zz' }, data)).toBeNull();
  });
});
