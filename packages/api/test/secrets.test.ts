import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const VALUE = 'super-secret-value-123';

describe('22.3 secrets: names and metadata only', () => {
  it('22.3 PUT stores the value and never returns, lists or audits it', async () => {
    api = await buildTestApi();
    const put = await api.call('admin', 'PUT', '/secrets/org/org/API_KEY', {
      body: { value: VALUE },
    });
    expect(put.status).toBe(200);
    expect(rec(put.body)).toMatchObject({
      scope: 'org',
      name: 'API_KEY',
      version: 1,
      ownerId: null,
    });
    const list = await api.call('admin', 'GET', '/secrets', { query: { scope: 'org' } });
    expect(rec(list.body).items).toHaveLength(1);
    const everything = [
      put.raw,
      list.raw,
      JSON.stringify(api.uow.audits),
      JSON.stringify(api.publisher.messages),
    ];
    for (const text of everything) expect(text).not.toContain(VALUE);
    expect(api.secrets.rows.get('org//API_KEY')?.value).toBe(VALUE);
  });

  it('22.3 replacing needs If-Match and bumps the version', async () => {
    api = await buildTestApi();
    const first = await api.call('admin', 'PUT', '/secrets/team/team-a/DB_PASS', {
      body: { value: 'one' },
    });
    const noMatch = await api.call('admin', 'PUT', '/secrets/team/team-a/DB_PASS', {
      body: { value: 'two' },
    });
    expect(noMatch.status).toBe(428);
    const second = await api.call('admin', 'PUT', '/secrets/team/team-a/DB_PASS', {
      headers: { 'if-match': String(first.headers.etag) },
      body: { value: 'two' },
    });
    expect(second.status).toBe(200);
    expect(rec(second.body).version).toBe(2);
  });

  it('22.3 validates names and refuses empty values', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('admin', 'PUT', '/secrets/org/org/bad%20name', { body: { value: 'x' } }))
        .status,
    ).toBe(400);
    expect(
      (await api.call('admin', 'PUT', '/secrets/org/org/OK', { body: { value: '' } })).status,
    ).toBe(400);
    expect((await api.call('admin', 'GET', '/secrets', { query: { scope: 'bogus' } })).status).toBe(
      400,
    );
  });

  it('22.3 DELETE needs If-Match, removes the secret and audits the name', async () => {
    api = await buildTestApi();
    const put = await api.call('admin', 'PUT', '/secrets/org/org/TMP', { body: { value: VALUE } });
    expect((await api.call('admin', 'DELETE', '/secrets/org/org/TMP')).status).toBe(428);
    const del = await api.call('admin', 'DELETE', '/secrets/org/org/TMP', {
      headers: { 'if-match': String(put.headers.etag) },
    });
    expect(del.status).toBe(204);
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'secret.delete' });
    expect((await api.call('admin', 'DELETE', '/secrets/org/org/TMP')).status).toBe(404);
  });

  it('10.1 team managers manage their own team secrets only', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('managerOwn', 'PUT', '/secrets/team/team-a/K', { body: { value: 'v' } }))
        .status,
    ).toBe(200);
    expect(
      (await api.call('managerOther', 'PUT', '/secrets/team/team-a/K', { body: { value: 'v' } }))
        .status,
    ).toBe(403);
    expect(
      (await api.call('managerOwn', 'PUT', '/secrets/org/org/K', { body: { value: 'v' } })).status,
    ).toBe(403);
    const own = await api.call('managerOwn', 'GET', '/secrets', {
      query: { scope: 'team', ownerId: 'team-a' },
    });
    expect(rec(own.body).items).toHaveLength(1);
    expect(
      (
        await api.call('managerOther', 'GET', '/secrets', {
          query: { scope: 'team', ownerId: 'team-a' },
        })
      ).status,
    ).toBe(403);
  });

  it('10.1 users manage only their own user secrets; auditors never see org or team secrets', async () => {
    api = await buildTestApi();
    expect(
      (
        await api.call('member', 'PUT', '/secrets/user/user-member-a/TOKEN', {
          body: { value: 'v' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call('member', 'PUT', '/secrets/user/user-member-b/TOKEN', {
          body: { value: 'v' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call('admin', 'PUT', '/secrets/user/user-member-a/TOKEN', {
          body: { value: 'v' },
        })
      ).status,
    ).toBe(403);
    const mine = await api.call('member', 'GET', '/secrets', { query: { scope: 'user' } });
    expect(rec(mine.body).items).toHaveLength(1);
    expect((await api.call('member', 'GET', '/secrets', { query: { scope: 'org' } })).status).toBe(
      403,
    );
    expect((await api.call('auditor', 'GET', '/secrets', { query: { scope: 'org' } })).status).toBe(
      403,
    );
    expect(
      (
        await api.call('auditor', 'GET', '/secrets', {
          query: { scope: 'team', ownerId: 'team-a' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api.call('member', 'PUT', '/secrets/user/ghost/TOKEN', { body: { value: 'v' } }))
        .status,
    ).toBe(403);
  });
});
