import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('11.7 manager request list reads', () => {
  it('11.7 loads team memberships once per distinct requester and never for the manager own rows', async () => {
    api = await buildTestApi();
    const rows: [string, string][] = [
      ['r1', 'user-member-b'],
      ['r2', 'user-member-a'],
      ['r3', 'user-manager-a'],
      ['r4', 'user-member-a'],
      ['r5', 'user-member-a'],
    ];
    let day = 0;
    for (const [id, requesterId] of rows) {
      day += 1;
      await api.store.seed('install_requests', {
        id,
        requesterId,
        sourceId: 'src-official',
        serverName: 'io.github.acme/remote-docs',
        version: '1.0.0',
        justification: id,
        status: 'open',
        decidedBy: null,
        decidedAt: null,
        reason: null,
        createdAt: `2026-06-0${day}T00:00:00.000Z`,
      });
    }
    const find = api.store.find.bind(api.store);
    const reads: string[] = [];
    api.store.find = async (collection, where) => {
      if (collection === 'team_members') reads.push(String(where.userId));
      return find(collection, where);
    };
    const res = await api.call('managerOwn', 'GET', '/install-requests', {
      query: { limit: '10' },
    });
    expect(res.status).toBe(200);
    expect(reads.sort()).toEqual(['user-member-a', 'user-member-b']);
  });
});
