import type { Sample, SampleFactory } from '../../http';
import { SEED_IDS } from '../../seed';

const SPEC_SAMPLE = {
  type: 'package',
  runtime: 'npm',
  identifier: '@acme/example-mcp',
  version: '1.0.0',
  size: 'small',
  egress: { allow: ['api.example.com'] },
  environmentVariables: [{ name: 'REGION', value: '{{var.REGION}}', isRequired: true }],
  auth: { mode: 'none' },
} as const;

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const catalogSamples: SampleFactory = (db) => {
  const draft = db.data.catalog.versions.find((v) => v.id === 'v-postgres-3.2.0');
  const kit = db.data.catalog.versions.find((v) => v.id === 'v-incident-kit-2.1.0');
  const jira = SEED_IDS.catalogEntry.jira;
  const v = `/catalog/c-postgres/versions/${draft?.id}`;
  const k = `/catalog/c-incident-kit/versions/${kit?.id}`;
  const samples: Sample[] = [
    { method: 'get', path: '/catalog' },
    { method: 'get', path: '/catalog?kind=plugin&q=incident' },
    {
      method: 'post',
      path: '/catalog',
      body: {
        slug: 'sample-server',
        kind: 'mcp_server',
        displayName: 'Sample server',
        description: 'A sample',
        visibility: { org: false, teamIds: ['t-data'], userIds: [] },
        risk: 'low',
        userOverrides: 'cosmetic',
        onDrift: 'hideChanged',
        autoUpgrade: true,
      },
    },
    { method: 'get', path: `/catalog/${jira}` },
    {
      method: 'patch',
      path: `/catalog/${jira}`,
      body: { description: 'Issues', risk: 'low', onDrift: 'warn' },
    },
    { method: 'get', path: `/catalog/${jira}/versions` },
    {
      method: 'post',
      path: `/catalog/${jira}/versions`,
      body: {
        label: '9.9.9',
        serverSpec: SPEC_SAMPLE,
        installForm: {
          variables: [{ name: 'REGION', label: 'Region', required: true }],
          secrets: [],
        },
        changelog: null,
      },
    },
    { method: 'get', path: v },
    { method: 'patch', path: v, body: { label: '3.2.1', serverSpec: SPEC_SAMPLE } },
    { method: 'post', path: `${v}/test` },
    { method: 'post', path: `${v}/test`, body: { variables: { REGION: 'eu' } } },
    { method: 'put', path: '/secrets/org/org/API_TOKEN', body: { value: 'shared-token' } },
    { method: 'put', path: '/secrets/user/u-me/API_TOKEN', body: { value: 'my-token' } },
    { method: 'get', path: '/secrets?scope=org' },
    {
      method: 'post',
      path: `${v}/publish`,
      body: { visibility: { org: true, teamIds: [], userIds: [] } },
    },
    { method: 'get', path: `${v}/overrides` },
    {
      method: 'put',
      path: `${v}/overrides`,
      body: { version: 1, tools: { pg_run_query: { hidden: true } } },
    },
    { method: 'get', path: '/catalog/c-postgres/default-overrides' },
    {
      method: 'put',
      path: '/catalog/c-postgres/default-overrides',
      body: { version: 1, tools: { pg_run_query: { hidden: true } } },
    },
    { method: 'get', path: `${k}/files` },
    { method: 'get', path: `${k}/files/SKILL.md` },
    {
      method: 'put',
      path: `${k}/files/references/notes.md`,
      body: { contentBase64: btoa('# Notes'), mode: 'file' },
    },
    { method: 'post', path: `${k}/approve-executable`, body: { note: 'Reviewed' } },
    { method: 'get', path: '/auto-install-policies' },
    {
      method: 'post',
      path: '/auto-install-policies',
      body: {
        catalogEntryId: jira,
        target: { teamIds: ['t-data'], roles: ['manager'], idpGroups: ['eng'] },
        mode: 'default',
        scope: 'user',
        applyToExisting: true,
        enabled: true,
      },
    },
    {
      method: 'patch',
      path: '/auto-install-policies/ap-1',
      body: { mode: 'required', enabled: false },
    },
    {
      method: 'post',
      path: '/auto-install-policies/ap-2/preview',
      body: { target: { all: true }, mode: 'default', scope: 'user', applyToExisting: true },
    },
    { method: 'delete', path: '/auto-install-policies/ap-1' },
    { method: 'delete', path: '/catalog/c-hubspot' },
  ];
  return samples;
};
