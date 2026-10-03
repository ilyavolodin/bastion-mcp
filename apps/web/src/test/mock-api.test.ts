/**
 * The MSW mock behaves like the API where the screens depend on it: versioned changes answer 428 and 412 (17.1),
 * lists page with opaque cursors and the API's limits (17.1), roles are decided by one table, and the mock clock is
 * the one source of time for what the mock stamps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, decodeCursor, encodeCursor, MAX_LIMIT, pageOf } from '@/mocks/http';
import { can } from '@/mocks/roles';
import { getDb, setRole } from '@/mocks/state';
import { advanceClock, DAY, HOUR, nowIso, nowMs, validationFailed } from '@/mocks/util';
import { listLimitRules } from './contract';
import { allowMissingIfMatch } from './if-match';

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`/api/v1${path}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', 'x-bastion-csrf': 'test-csrf', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** One versioned change per mock domain: routes of the OpenAPI document marked `x-requires-if-match`. */
const VERSIONED: [method: string, path: string, body: unknown][] = [
  ['patch', '/users/u-raj', { displayName: 'Raj' }],
  ['delete', '/role-mapping-rules/rm-1', undefined],
  ['patch', '/policy-rules/no-github-delete', { name: 'No deletes' }],
  ['patch', '/custom-policies/cp-1', { name: 'Slack guard' }],
  ['patch', '/oauth-clients/cursor-desktop', { blocked: false }],
  ['patch', '/catalog/c-jira', { description: 'Issues' }],
  ['patch', '/registry-sources/rs-acme', { name: 'Acme registry' }],
  ['put', '/registry-sources/rs-official/policy', {}],
  ['patch', '/installations/i-jira', { displayName: 'Jira cloud' }],
  ['delete', '/installations/i-jira', undefined],
  ['put', '/installations/i-jira/overrides', { version: 1 }],
  ['patch', '/endpoints/e-eng', { displayName: 'Eng' }],
  ['patch', '/settings', { personalInstalls: 'all' }],
  ['patch', '/idp-connections/idp-1', { name: 'Okta' }],
  ['patch', '/limit-rules/lr-1', { name: 'Calls' }],
  ['put', '/settings/model-guards', { jev: null, llmJudge: null, classifier: null }],
  ['patch', '/me', { displayName: 'Dana' }],
];

describe('versioned changes (17.1)', () => {
  beforeEach(allowMissingIfMatch);

  for (const [method, path, body] of VERSIONED) {
    it(`${method.toUpperCase()} ${path}: 428 without If-Match, 412 with another version, accepted with *`, async () => {
      const missing = await call(method, path, {}, body);
      expect(missing.status).toBe(428);
      const stale = await call(method, path, { 'if-match': '"1999-01-01T00:00:00.000Z"' }, body);
      expect(stale.status).toBe(412);
      const any = await call(method, path, { 'if-match': '*' }, body);
      expect([412, 428]).not.toContain(any.status);
    });
  }

  it('an auto-install policy is versioned too', async () => {
    const id = getDb().data.catalog.autoInstall[0]?.id;
    if (!id) throw new Error('fixture missing');
    expect(
      (await call('patch', `/auto-install-policies/${id}`, {}, { enabled: false })).status,
    ).toBe(428);
    const stale = { 'if-match': '"1999-01-01T00:00:00.000Z"' };
    expect((await call('delete', `/auto-install-policies/${id}`, stale)).status).toBe(412);
  });

  it('the version named by the last GET is accepted, and the change moves it on', async () => {
    const first = await call('get', '/idp-connections/idp-1');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const patched = await call(
      'patch',
      '/idp-connections/idp-1',
      { 'if-match': etag },
      { name: 'A' },
    );
    expect(patched.status).toBe(200);
    expect(patched.headers.get('etag')).not.toBe(etag);
    const again = await call(
      'patch',
      '/idp-connections/idp-1',
      { 'if-match': etag },
      { name: 'B' },
    );
    expect(again.status).toBe(412);
  });

  it('a new team member needs no version, an existing one does', async () => {
    const fresh = await call('put', '/teams/t-support/members/u-tom', {}, { role: 'member' });
    expect(fresh.status).toBe(200);
    const existing = await call('put', '/teams/t-support/members/u-tom', {}, { role: 'manager' });
    expect(existing.status).toBe(428);
  });
});

describe('pages (17.1)', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  const page = (query: string) => pageOf(rows, new URL(`http://mock/x${query}`));

  it("follow the API's limit rules: default 50, at most 500", () => {
    const rules = listLimitRules();
    expect([DEFAULT_LIMIT, MAX_LIMIT]).toEqual([rules.default, rules.maximum]);
    expect(page('').items).toHaveLength(DEFAULT_LIMIT);
    const many = Array.from({ length: 900 }, (_, i) => i);
    expect(pageOf(many, new URL('http://mock/x?limit=9999')).items).toHaveLength(MAX_LIMIT);
    expect(page('?limit=0').items).toHaveLength(DEFAULT_LIMIT);
    expect(page('?limit=-3').items).toHaveLength(1);
  });

  it('cursors are opaque: not an offset a screen could build or read', () => {
    const first = page('?limit=50');
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toMatch(/^\d+$/);
    expect(decodeCursor(first.nextCursor)).toBe(50);
    const second = page(`?limit=50&cursor=${first.nextCursor}`);
    expect(second.items[0]).toBe(50);
    const last = page(`?limit=50&cursor=${encodeCursor(100)}`);
    expect(last.items).toHaveLength(20);
    expect(last.nextCursor).toBeNull();
    expect(page('?cursor=50').items[0]).toBe(0);
    expect(page('?cursor=%25%25').items[0]).toBe(0);
  });
});

describe('roles', () => {
  it('one table says what each role may do', () => {
    const table = (action: Parameters<typeof can>[0]) =>
      (['admin', 'manager', 'member', 'auditor'] as const).filter((r) => {
        setRole(r);
        return can(action);
      });
    expect(table('admin')).toEqual(['admin']);
    expect(table('manage')).toEqual(['admin', 'manager']);
    expect(table('seeAll')).toEqual(['admin', 'auditor']);
    expect(table('readConfig')).toEqual(['admin', 'manager', 'auditor']);
    expect(table('registry')).toEqual(['admin', 'manager', 'member']);
  });

  it('a route answers 403 to a role the table leaves out, before it looks at the row', async () => {
    setRole('member');
    expect((await call('patch', '/policy-rules/nope', { 'if-match': '*' }, {})).status).toBe(403);
    expect((await call('get', '/teams')).status).toBe(403);
  });
});

describe('the mock clock and the problem shape', () => {
  it('stamps are strictly increasing, so a changed row has a new version', () => {
    const a = nowMs();
    const b = nowMs();
    expect(b).toBeGreaterThan(a);
    expect(nowIso() > new Date(a).toISOString()).toBe(true);
  });

  it('a test moves time forward by moving the clock: a catalog test run settles', async () => {
    const draft = getDb().data.catalog.versions.find((v) => v.status === 'draft');
    if (!draft) throw new Error('fixture missing');
    const path = `/catalog/${draft.entryId}/versions/${draft.id}`;
    const started = await call('post', `${path}/test`, {}, {});
    expect(started.status).toBe(202);
    const running = (await (await call('get', path)).json()) as { testResult: { status: string } };
    expect(running.testResult.status).toBe('running');
    advanceClock(HOUR);
    const settled = (await (await call('get', path)).json()) as { testResult: { status: string } };
    expect(settled.testResult.status).toBe('passed');
  });

  it('seeded history sits before now', () => {
    const { now } = getDb();
    expect(getDb().data.access.users.every((u) => new Date(u.updatedAt).getTime() < now)).toBe(
      true,
    );
    expect(DAY).toBe(24 * HOUR);
  });

  it('validationFailed is the 422 of the mock with its field errors', async () => {
    const res = validationFailed([{ path: '/name', message: 'Required' }]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'validation_failed',
      status: 422,
      errors: [{ path: '/name', message: 'Required' }],
    });
  });
});
