import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const ids = (v: unknown): string[] =>
  ((v as { items: Array<{ id: unknown }> }).items ?? []).map((i) => String(i.id));

describe('17.1 the sort query convention on installation and version lists', () => {
  it('17.1 ?sort=field orders ascending and ?sort=-field descending on /installations', async () => {
    api = await buildTestApi();
    const asc = ids(
      (await api.call('admin', 'GET', '/installations', { query: { sort: 'id' } })).body,
    );
    const desc = ids(
      (await api.call('admin', 'GET', '/installations', { query: { sort: '-id' } })).body,
    );
    expect(asc.length).toBeGreaterThan(1);
    expect(asc).toEqual([...asc].sort());
    expect(desc).toEqual([...asc].reverse());
  });

  it('17.1 ?sort=field orders ascending and ?sort=-field descending on catalog versions', async () => {
    api = await buildTestApi();
    const url = '/catalog/entry-team-a/versions';
    const asc = ids((await api.call('managerOwn', 'GET', url, { query: { sort: 'id' } })).body);
    const desc = ids((await api.call('managerOwn', 'GET', url, { query: { sort: '-id' } })).body);
    expect(asc.length).toBeGreaterThan(1);
    expect(asc).toEqual([...asc].sort());
    expect(desc).toEqual([...asc].reverse());
  });

  it('17.1 catalog versions default to newest first when no sort is given', async () => {
    api = await buildTestApi();
    const url = '/catalog/entry-team-a/versions';
    const none = ids((await api.call('managerOwn', 'GET', url)).body);
    const created = ids(
      (await api.call('managerOwn', 'GET', url, { query: { sort: '-createdAt' } })).body,
    );
    expect(none).toEqual(created);
  });
});
