import type { Sample, SampleFactory } from '../../http';
import { SEED_IDS } from '../../seed';

/** One valid call per route (route-contract.test.ts checks the bodies and responses against the OpenAPI schemas). */
export const serversSamples: SampleFactory = (db) => {
  const s = db.data.servers;
  const inst = s.installations.find((i) => i.id === SEED_IDS.installation.jira);
  const sandboxed = s.installations.find((i) => i.id === SEED_IDS.installation.postgres);
  const endpoint = s.endpoints[0];
  const entry = db.data.catalog.entries.find((e) => e.slug === 'servicedesk');
  const samples: Sample[] = [
    { method: 'get', path: '/installations' },
    { method: 'get', path: '/store' },
    { method: 'get', path: '/endpoints' },
    { method: 'get', path: '/client-config?client=claude-code' },
    { method: 'get', path: '/store/jira' },
    {
      method: 'post',
      path: '/installations',
      body: {
        catalogEntryId: entry?.id ?? 'c-servicedesk',
        ownerType: 'user',
        slug: 'servicedesk',
        variables: {},
        pinnedVersion: false,
      },
    },
    {
      method: 'post',
      path: '/endpoints',
      body: {
        slug: 'ops',
        displayName: 'Ops',
        installationIds: [SEED_IDS.installation.jira],
        prefixMode: 'onCollision',
        instructions: 'Use for operations work.',
      },
    },
  ];
  if (inst) {
    const base = `/installations/${inst.id}`;
    samples.push(
      { method: 'get', path: base },
      { method: 'get', path: `${base}/tools` },
      { method: 'get', path: `${base}/prompts` },
      { method: 'get', path: `${base}/resources` },
      { method: 'get', path: `${base}/templates` },
      { method: 'get', path: `${base}/egress` },
      { method: 'get', path: `${base}/overrides` },
      {
        method: 'put',
        path: `${base}/overrides`,
        body: { version: 1, tools: { search_issues: { title: 'Find issues' } } },
      },
      {
        method: 'post',
        path: `${base}/try`,
        body: { kind: 'tool', name: 'search_issues', arguments: { query: 'bug' } },
      },
      {
        method: 'patch',
        path: base,
        body: { displayName: 'Jira (work)', toolPrefix: 'jira_work', enabled: true },
      },
      { method: 'post', path: `${base}/restart` },
      { method: 'post', path: `${base}/connect`, body: { returnTo: `/servers/${inst.id}` } },
      { method: 'put', path: `${base}/secrets/API_KEY`, body: { value: 'secret' } },
      { method: 'delete', path: `${base}/connection` },
      {
        method: 'post',
        path: '/overrides/preview',
        body: {
          doc: { version: 1, tools: { get_issue: { description: 'Read an issue' } } },
          layer: 'installation',
          installationId: inst.id,
        },
      },
    );
  }
  if (sandboxed) {
    samples.push(
      { method: 'get', path: `/installations/${sandboxed.id}/egress` },
      { method: 'delete', path: `/installations/${sandboxed.id}` },
    );
  }
  if (endpoint) {
    samples.push(
      { method: 'get', path: `/endpoints/${endpoint.id}` },
      {
        method: 'patch',
        path: `/endpoints/${endpoint.id}`,
        body: { displayName: 'Engineering tools', prefixMode: 'onCollision', instructions: null },
      },
      { method: 'delete', path: `/endpoints/${endpoint.id}` },
      { method: 'get', path: `/endpoints/${endpoint.id}/client-config?client=cursor` },
    );
  }
  return samples;
};
