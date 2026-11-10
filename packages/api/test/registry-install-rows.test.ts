import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const REMOTE = { sourceId: 'src-official', name: 'io.github.acme/remote-docs', version: '1.0.0' };
const NPM = { sourceId: 'src-official', name: 'io.github.acme/npm-tool', version: '2.1.0' };

/** `updatedAt` comes from the memory store's tick counter, which depends on unrelated seed work. */
const withoutTick = (rows: Record<string, unknown>[]) =>
  rows.map(({ updatedAt: _tick, ...rest }) => rest);

const registryRows = async (t: TestApi, name: string) => {
  const entries = await t.store.find('catalog_entries', { registryServerName: name });
  const entryIds = entries.map((e) => e.id);
  const versions = (await t.store.find('catalog_versions', {})).filter((v) =>
    entryIds.includes(v.entryId as string),
  );
  const installations = (await t.store.find('installations', { origin: 'registry' })).filter((i) =>
    entryIds.includes(i.catalogEntryId as string),
  );
  return {
    entries: withoutTick(entries),
    versions: withoutTick(versions),
    installations: withoutTick(installations),
  };
};

describe('11.7 rows written by the install plan', () => {
  it('11.7 first install writes entry, version and installation with ids in that order', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(res.status).toBe(201);
    const { entries, versions, installations } = await registryRows(api, REMOTE.name);
    expect(entries).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(installations).toHaveLength(1);
    const [entry] = entries;
    const [version] = versions;
    const [inst] = installations;
    expect(entry).toMatchInlineSnapshot(`
      {
        "autoUpgrade": false,
        "createdAt": "2026-06-01T12:00:00.000Z",
        "createdBy": "user-member-a",
        "currentVersionId": null,
        "description": "Search the Acme docs",
        "displayName": "Acme Docs",
        "id": "id-1",
        "kind": "mcp_server",
        "onDrift": "hideChanged",
        "ownerTeamId": null,
        "registryServerName": "io.github.acme/remote-docs",
        "registrySourceId": "src-official",
        "risk": "low",
        "slug": "remote-docs",
        "source": {
          "kind": "registry",
          "registrySourceId": "src-official",
          "serverName": "io.github.acme/remote-docs",
          "trust": "official",
          "version": "1.0.0",
        },
        "status": "draft",
        "tags": [],
        "userOverrides": "cosmetic",
        "visibility": {
          "org": false,
          "teamIds": [],
          "userIds": [
            "user-member-a",
          ],
        },
      }
    `);
    expect(version).toMatchInlineSnapshot(`
      {
        "changelog": null,
        "createdAt": "2026-06-01T12:00:00.000Z",
        "createdBy": "user-member-a",
        "entryId": "id-1",
        "guardProfileId": null,
        "id": "id-2",
        "installForm": {
          "secrets": [],
          "variables": [],
        },
        "label": "1.0.0",
        "limits": [],
        "lockfile": null,
        "overrides": {},
        "protocolEra": null,
        "publishedAt": null,
        "referenceSnapshotId": null,
        "runtime": {
          "kind": "remote",
        },
        "serverSpec": {
          "auth": {
            "mode": "none",
          },
          "transport": "streamable-http",
          "type": "remote",
          "url": "https://mcp.acme.example/mcp",
        },
        "status": "draft",
        "testResult": null,
      }
    `);
    expect(inst).toMatchInlineSnapshot(`
      {
        "catalogEntryId": "id-1",
        "catalogVersionId": "id-2",
        "createdAt": "2026-06-01T12:00:00.000Z",
        "displayName": "Acme Docs",
        "enabled": true,
        "id": "id-3",
        "origin": "registry",
        "overrides": {},
        "ownerId": "user-member-a",
        "ownerType": "user",
        "personalSpec": null,
        "pinnedVersion": true,
        "secretRefs": {},
        "slug": "remote-docs",
        "status": "ready",
        "statusDetail": {
          "automaticTest": true,
        },
        "toolPrefix": "remote_docs",
        "variables": {},
      }
    `);
    const n = (id: unknown) => Number(String(id).replace('id-', ''));
    expect(n(entry?.id)).toBeLessThan(n(version?.id));
    expect(n(version?.id)).toBeLessThan(n(inst?.id));
  });

  it('11.7 a second user widens the entry visibility, reuses the version and gets their own slug', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    await api.call('admin', 'POST', '/registry/install', { body: REMOTE });
    const { entries, versions, installations } = await registryRows(api, REMOTE.name);
    expect(entries).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(entries[0]?.visibility).toMatchInlineSnapshot(`
      {
        "org": false,
        "teamIds": [],
        "userIds": [
          "user-member-a",
          "user-admin",
        ],
      }
    `);
    expect(
      installations.map((i) => [i.ownerId, i.slug, i.toolPrefix, i.catalogVersionId]),
    ).toMatchInlineSnapshot(`
      [
        [
          "user-member-a",
          "remote-docs",
          "remote_docs",
          "id-2",
        ],
        [
          "user-admin",
          "remote-docs",
          "remote_docs",
          "id-2",
        ],
      ]
    `);
  });

  it('11.7 installing the same server again by the same user takes the next free installation slug', async () => {
    api = await buildTestApi();
    const first = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    const second = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect([first.status, second.status]).toMatchInlineSnapshot(`
      [
        201,
        201,
      ]
    `);
    const { entries, versions, installations } = await registryRows(api, REMOTE.name);
    expect(entries[0]?.visibility).toMatchInlineSnapshot(`
      {
        "org": false,
        "teamIds": [],
        "userIds": [
          "user-member-a",
        ],
      }
    `);
    expect(versions).toHaveLength(1);
    expect(installations.map((i) => [i.slug, i.toolPrefix])).toMatchInlineSnapshot(`
      [
        [
          "remote-docs",
          "remote_docs",
        ],
        [
          "remote-docs-2",
          "remote_docs_2",
        ],
      ]
    `);
  });

  it('11.7 an npm install with secrets is needs_setup and carries the automatic test in statusDetail', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/registry/install', { body: NPM });
    const { installations, versions } = await registryRows(api, NPM.name);
    expect(installations[0]).toMatchInlineSnapshot(`
      {
        "catalogEntryId": "id-1",
        "catalogVersionId": "id-2",
        "createdAt": "2026-06-01T12:00:00.000Z",
        "displayName": "npm-tool",
        "enabled": true,
        "id": "id-3",
        "origin": "registry",
        "overrides": {},
        "ownerId": "user-member-a",
        "ownerType": "user",
        "personalSpec": null,
        "pinnedVersion": true,
        "secretRefs": {},
        "slug": "npm-tool",
        "status": "needs_setup",
        "statusDetail": {
          "automaticTest": true,
        },
        "toolPrefix": "npm_tool",
        "variables": {},
      }
    `);
    expect(versions[0]).toMatchInlineSnapshot(`
      {
        "changelog": null,
        "createdAt": "2026-06-01T12:00:00.000Z",
        "createdBy": "user-member-a",
        "entryId": "id-1",
        "guardProfileId": null,
        "id": "id-2",
        "installForm": {
          "secrets": [
            {
              "label": "ACME_TOKEN",
              "name": "ACME_TOKEN",
            },
          ],
          "variables": [],
        },
        "label": "2.1.0",
        "limits": [],
        "lockfile": null,
        "overrides": {},
        "protocolEra": null,
        "publishedAt": null,
        "referenceSnapshotId": null,
        "runtime": {
          "kind": "npm",
        },
        "serverSpec": {
          "allowInstallScripts": false,
          "auth": {
            "fields": [
              {
                "label": "ACME_TOKEN",
                "name": "ACME_TOKEN",
              },
            ],
            "inject": [
              {
                "name": "ACME_TOKEN",
                "to": "env",
                "value": "{{secret.ACME_TOKEN}}",
              },
            ],
            "mode": "userSecret",
          },
          "egress": {
            "allow": [],
          },
          "identifier": "@acme/mcp-tool",
          "idleTimeoutMinutes": 15,
          "instanceScope": "perUser",
          "protocol": "legacy",
          "runtime": "npm",
          "size": "small",
          "type": "package",
          "version": "2.1.0",
          "workspace": {
            "persistent": false,
            "sizeMiB": 512,
          },
        },
        "status": "draft",
        "testResult": null,
      }
    `);
  });

  it('11.7 approving a request runs the same plan for the requester', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'POST', '/install-requests/req-1/approve');
    expect(res.status).toBe(200);
    const { entries, versions, installations } = await registryRows(api, NPM.name);
    expect(entries[0]).toMatchInlineSnapshot(`
      {
        "autoUpgrade": false,
        "createdAt": "2026-06-01T12:00:00.000Z",
        "createdBy": "user-member-a",
        "currentVersionId": null,
        "description": "A local tool run with npx",
        "displayName": "npm-tool",
        "id": "id-1",
        "kind": "mcp_server",
        "onDrift": "hideChanged",
        "ownerTeamId": null,
        "registryServerName": "io.github.acme/npm-tool",
        "registrySourceId": "src-official",
        "risk": "low",
        "slug": "npm-tool",
        "source": {
          "kind": "registry",
          "registrySourceId": "src-official",
          "serverName": "io.github.acme/npm-tool",
          "trust": "official",
          "version": "2.1.0",
        },
        "status": "draft",
        "tags": [],
        "userOverrides": "cosmetic",
        "visibility": {
          "org": false,
          "teamIds": [],
          "userIds": [
            "user-member-a",
          ],
        },
      }
    `);
    expect(versions[0]).toMatchInlineSnapshot(`
      {
        "changelog": null,
        "createdAt": "2026-06-01T12:00:00.000Z",
        "createdBy": "user-member-a",
        "entryId": "id-1",
        "guardProfileId": null,
        "id": "id-2",
        "installForm": {
          "secrets": [
            {
              "label": "ACME_TOKEN",
              "name": "ACME_TOKEN",
            },
          ],
          "variables": [],
        },
        "label": "2.1.0",
        "limits": [],
        "lockfile": null,
        "overrides": {},
        "protocolEra": null,
        "publishedAt": null,
        "referenceSnapshotId": null,
        "runtime": {
          "kind": "npm",
        },
        "serverSpec": {
          "allowInstallScripts": false,
          "auth": {
            "fields": [
              {
                "label": "ACME_TOKEN",
                "name": "ACME_TOKEN",
              },
            ],
            "inject": [
              {
                "name": "ACME_TOKEN",
                "to": "env",
                "value": "{{secret.ACME_TOKEN}}",
              },
            ],
            "mode": "userSecret",
          },
          "egress": {
            "allow": [],
          },
          "identifier": "@acme/mcp-tool",
          "idleTimeoutMinutes": 15,
          "instanceScope": "perUser",
          "protocol": "legacy",
          "runtime": "npm",
          "size": "small",
          "type": "package",
          "version": "2.1.0",
          "workspace": {
            "persistent": false,
            "sizeMiB": 512,
          },
        },
        "status": "draft",
        "testResult": null,
      }
    `);
    expect(installations[0]).toMatchInlineSnapshot(`
      {
        "catalogEntryId": "id-1",
        "catalogVersionId": "id-2",
        "createdAt": "2026-06-01T12:00:00.000Z",
        "displayName": "npm-tool",
        "enabled": true,
        "id": "id-3",
        "origin": "registry",
        "overrides": {},
        "ownerId": "user-member-a",
        "ownerType": "user",
        "personalSpec": null,
        "pinnedVersion": true,
        "secretRefs": {},
        "slug": "npm-tool",
        "status": "needs_setup",
        "statusDetail": {
          "automaticTest": true,
        },
        "toolPrefix": "npm_tool",
        "variables": {},
      }
    `);
  });
});
