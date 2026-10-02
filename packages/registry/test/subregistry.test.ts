import { META_KEYS } from '@bastion-mcp/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildSubregistryEntries,
  getSubregistryVersion,
  getSubregistryVersions,
  listSubregistryServers,
  registryNamespaceFromHost,
  SUBREGISTRY_META_KEY,
  type SubregistryInput,
} from '../src';

const input = (n = 2): SubregistryInput => ({
  host: 'bastion.acme.com',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  installations: Array.from({ length: n }, (_, i) => ({
    installationId: `inst-${i}`,
    slug: `server-${String(i).padStart(3, '0')}`,
    displayName: `Server ${i}`,
    catalogEntryId: `cat-${i}`,
    version: '2.0.0',
  })),
});

describe('11.8 subregistry', () => {
  it('11.8 names are reverse-DNS from the host and the port is dropped', () => {
    expect(registryNamespaceFromHost('bastion.acme.com')).toBe('com.acme.bastion');
    expect(registryNamespaceFromHost('https://Bastion.Acme.com:8443/path')).toBe(
      'com.acme.bastion',
    );
    expect(registryNamespaceFromHost('localhost:3000')).toBe('localhost');
    expect(registryNamespaceFromHost('[::1]:3000')).toBe('1');
    expect(registryNamespaceFromHost('')).toBe('localhost');
  });

  it('11.8 one entry for the default endpoint and one per installation with streamable-http remotes', () => {
    const entries = buildSubregistryEntries(input());
    expect(entries.map((e) => e.server.name)).toEqual([
      'com.acme.bastion/_default',
      'com.acme.bastion/server-000',
      'com.acme.bastion/server-001',
    ]);
    expect(entries.map((e) => e.server.remotes)).toEqual([
      [{ type: 'streamable-http', url: 'https://bastion.acme.com/mcp' }],
      [{ type: 'streamable-http', url: 'https://bastion.acme.com/mcp/i/server-000' }],
      [{ type: 'streamable-http', url: 'https://bastion.acme.com/mcp/i/server-001' }],
    ]);
  });

  it('11.8 Bastion metadata lives under _meta["io.github.bastion-mcp/registry"]', () => {
    expect(SUBREGISTRY_META_KEY).toBe(META_KEYS.registry);
    const [def, first] = buildSubregistryEntries(input());
    expect(first?._meta[META_KEYS.registry]).toMatchObject({
      kind: 'installation',
      slug: 'server-000',
      installationId: 'inst-0',
      catalogEntryId: 'cat-0',
    });
    expect(def?._meta[META_KEYS.registry]).toMatchObject({ kind: 'default', slug: null });
    expect(first?.server._meta[META_KEYS.registry]).toBeDefined();
    expect(first?._meta['io.modelcontextprotocol.registry/official']).toMatchObject({
      status: 'active',
      isLatest: true,
    });
  });

  it('11.8 the scheme can be http for local deployments and disabled installations are marked', () => {
    const entries = buildSubregistryEntries({
      ...input(1),
      host: 'localhost:3000',
      scheme: 'http',
      installations: [
        {
          installationId: 'i',
          slug: 'off',
          displayName: 'Off',
          enabled: false,
          description: 'd',
          createdAt: new Date(0),
          updatedAt: new Date(1),
        },
      ],
    });
    expect(entries[0]?.server.remotes[0]?.url).toBe('http://localhost:3000/mcp');
    expect(entries[1]?._meta[META_KEYS.registry]).toMatchObject({ enabled: false });
    expect(entries[1]?.server.version).toBe('1.0.0');
  });

  it('11.8 list paginates with opaque cursors and covers every entry exactly once', () => {
    const data = input(75);
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listSubregistryServers(data, { limit: 30, cursor });
      names.push(...page.servers.map((s) => s.server.name));
      expect(page.metadata.count).toBe(page.servers.length);
      cursor = page.metadata.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(names).toHaveLength(76);
    expect(new Set(names).size).toBe(76);
  });

  it('11.8 the page size is clamped and a foreign cursor restarts at the top', () => {
    const data = input(150);
    expect(listSubregistryServers(data, { limit: 1000 }).servers).toHaveLength(100);
    expect(listSubregistryServers(data, { limit: 0 }).servers).toHaveLength(1);
    expect(listSubregistryServers(data).servers).toHaveLength(30);
    const cursor = listSubregistryServers(data, { limit: 10 }).metadata.nextCursor;
    const other = listSubregistryServers(input(5), { limit: 10, cursor });
    expect(other.servers[0]?.server.name).toBe('com.acme.bastion/_default');
    expect(listSubregistryServers(data, { cursor: 'garbage' }).servers[0]?.server.name).toBe(
      'com.acme.bastion/_default',
    );
    expect(cursor?.startsWith('bcur1.')).toBe(true);
  });

  it('11.8 search filters by name, title or description', () => {
    const out = listSubregistryServers(input(12), { search: 'SERVER-011' });
    expect(out.servers.map((s) => s.server.name)).toEqual(['com.acme.bastion/server-011']);
    expect(listSubregistryServers(input(3), { search: 'nothing-like-this' }).servers).toEqual([]);
  });

  it('11.8 versions of a name accept URL-encoded names and 404 otherwise', () => {
    const data = input();
    const encoded = encodeURIComponent('com.acme.bastion/server-001');
    expect(getSubregistryVersions(data, encoded)?.servers.map((s) => s.server.name)).toEqual([
      'com.acme.bastion/server-001',
    ]);
    expect(getSubregistryVersions(data, 'com.acme.bastion/server-001')?.metadata.count).toBe(1);
    expect(getSubregistryVersions(data, 'com.acme.bastion/missing')).toBeNull();
    expect(getSubregistryVersions(data, '%E0%A4%A')).toBeNull();
  });

  it('11.8 a single version resolves by exact version or latest', () => {
    const data = input();
    expect(
      getSubregistryVersion(data, 'com.acme.bastion/server-000', '2.0.0')?.server.version,
    ).toBe('2.0.0');
    expect(getSubregistryVersion(data, 'com.acme.bastion/server-000', 'latest')).not.toBeNull();
    expect(getSubregistryVersion(data, 'com.acme.bastion/server-000', '9.9.9')).toBeNull();
    expect(getSubregistryVersion(data, 'com.acme.bastion/none', 'latest')).toBeNull();
  });

  it('property 11.8 entry names are valid registry names for any host', () => {
    fc.assert(
      fc.property(fc.domain(), (host) => {
        const [def] = buildSubregistryEntries({ host, installations: [] });
        expect(def?.server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
      }),
    );
  });
});
