import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const REMOTE = { sourceId: 'src-official', name: 'io.github.acme/remote-docs', version: '1.0.0' };

describe('11.7 install visibility membership', () => {
  it('11.7 a user id that only appears inside teamIds is still added to userIds on install', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    const [entry] = await api.store.find('catalog_entries', { registryServerName: REMOTE.name });
    await api.store.update('catalog_entries', String(entry?.id), {
      visibility: { org: false, teamIds: ['user-member-a'], userIds: [] },
    });
    const res = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(res.status).toBe(201);
    const after = await api.store.get('catalog_entries', String(entry?.id));
    expect(after?.visibility).toEqual({
      org: false,
      teamIds: ['user-member-a'],
      userIds: ['user-member-a'],
    });
  });

  it('11.7 a user id that is a substring of another userId is not treated as present', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    const [entry] = await api.store.find('catalog_entries', { registryServerName: REMOTE.name });
    await api.store.update('catalog_entries', String(entry?.id), {
      visibility: { org: false, teamIds: [], userIds: ['user-member-abc'] },
    });
    await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    const after = await api.store.get('catalog_entries', String(entry?.id));
    expect(after?.visibility).toEqual({
      org: false,
      teamIds: [],
      userIds: ['user-member-abc', 'user-member-a'],
    });
  });
});
