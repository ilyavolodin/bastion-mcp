/** Catalog versions: drafts, the test run (11.2), publishing, and the per-version and default overrides. */
import type { Body, Schemas } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  HttpResponse,
  notFound,
  pageOf,
  problem,
  route,
} from '../../http';
import { getDb, nextId } from '../../state';
import { nowIso, nowMs } from '../../util';
import { approvalOf } from './files';
import { passingRun } from './seed';
import {
  currentVersion,
  data,
  entryOf,
  entryRoute,
  validation,
  versionOf,
  versionRoute,
} from './store';
import type { Run, Version } from './types';

/** How long a test runs before it passes, on the mock clock (`util.ts`: a test moves it with `advanceClock`). */
const SETTLE_MS = 1200;

/** A running test finishes a moment after it started (11.2); the version row then carries the passing run. */
export const settle = (v: Version): void => {
  const started = data().testStarts[v.id];
  if (started && v.testResult?.status === 'running' && nowMs() - started > SETTLE_MS) {
    v.testResult = passingRun(v.id, new Date(started).toISOString());
    delete data().testStarts[v.id];
  }
};

export const detail = (v: Version): Schemas['CatalogVersionDetail'] => {
  settle(v);
  const files = data().files.some((f) => f.versionId === v.id);
  return files ? { ...v, approval: approvalOf(v) } : { ...v };
};

type VersionCreate = Body<'post', '/catalog/{id}/versions'>;

export const versionHandlers = [
  route.get(
    '/catalog/{id}/versions',
    ({ params, url }) => {
      if (!entryOf(params.id)) return notFound('Catalog entry');
      const rows = data()
        .versions.filter((v) => v.entryId === params.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      rows.forEach(settle);
      return HttpResponse.json(pageOf(rows, url));
    },
    { allow: 'readConfig' },
  ),

  entryRoute.post(
    '/catalog/{id}/versions',
    async ({ entry: e, body }) => {
      const input: VersionCreate = await body();
      if (!input.label?.trim()) return validation([{ path: '/label', message: 'Required' }]);
      if (data().versions.some((v) => v.entryId === e.id && v.label === input.label))
        return problem(409, 'conflict', `Version ${input.label} already exists`);
      const at = nowIso();
      const v: Version = {
        id: nextId('v'),
        entryId: e.id,
        label: input.label,
        serverSpec: (input.serverSpec ?? null) as Version['serverSpec'],
        overrides: { version: 1 },
        guardProfileId: null,
        limits: [],
        installForm: {
          variables: input.installForm?.variables ?? [],
          secrets: input.installForm?.secrets ?? [],
        },
        lockfile: null,
        referenceSnapshotId: null,
        protocolEra: null,
        testResult: null,
        runtime: {},
        status: 'draft',
        changelog: input.changelog ?? null,
        createdBy: getDb().me.id,
        createdAt: at,
        publishedAt: null,
        updatedAt: at,
      };
      data().versions.unshift(v);
      return HttpResponse.json(v, { status: 201, headers: etagHeaders(v.updatedAt) });
    },
    { allow: 'manage' },
  ),

  route.get(
    '/catalog/{id}/versions/{vid}',
    ({ params }) => {
      const v = versionOf(params.id, params.vid);
      return v
        ? HttpResponse.json(detail(v), { headers: etagHeaders(v.updatedAt) })
        : notFound('Version');
    },
    { allow: 'readConfig' },
  ),

  versionRoute.patch(
    '/catalog/{id}/versions/{vid}',
    async ({ version: v, request, body }) => {
      const stale = checkVersion(request, v);
      if (stale) return stale;
      if (v.status !== 'draft')
        return problem(409, 'version_immutable', 'Published versions cannot be edited');
      const patch = await body();
      if (patch.label !== undefined && !patch.label.trim())
        return validation([{ path: '/label', message: 'Required' }]);
      if (
        patch.label &&
        data().versions.some(
          (x) => x.entryId === v.entryId && x.id !== v.id && x.label === patch.label,
        )
      )
        return problem(409, 'conflict', `Version ${patch.label} already exists`);
      if (patch.label !== undefined) v.label = patch.label;
      if (patch.serverSpec !== undefined) {
        v.serverSpec = patch.serverSpec as Version['serverSpec'];
        v.testResult = null; // any change to the spec invalidates the test (11.2)
      }
      if (patch.installForm) {
        v.installForm = {
          variables: patch.installForm.variables ?? v.installForm.variables,
          secrets: patch.installForm.secrets ?? v.installForm.secrets,
        };
      }
      if (patch.changelog !== undefined) v.changelog = patch.changelog;
      v.updatedAt = nowIso();
      return HttpResponse.json(v, { headers: etagHeaders(v.updatedAt) });
    },
    { allow: 'manage' },
  ),

  versionRoute.post(
    '/catalog/{id}/versions/{vid}/test',
    ({ version: v }) => {
      const startedAt = nowIso();
      data().testStarts[v.id] = nowMs();
      const run: Run = {
        id: nextId('run'),
        versionId: v.id,
        status: 'running',
        startedAt,
        finishedAt: null,
        steps: [
          { id: 'prepare', status: 'passed', detail: 'npx -y …' },
          { id: 'connect', status: 'running' },
        ],
      };
      v.testResult = run;
      return HttpResponse.json(run, { status: 202 });
    },
    { allow: 'manage' },
  ),

  versionRoute.post(
    '/catalog/{id}/versions/{vid}/publish',
    async ({ entry: e, version: v, body }) => {
      if (v.status !== 'draft')
        return problem(409, 'version_immutable', 'Published versions cannot be edited');
      settle(v);
      if (v.testResult?.status !== 'passed') {
        return problem(
          409,
          'test_required',
          'Run a passing test first',
          'Publishing needs a passing test of this exact version.',
        );
      }
      if (data().files.some((f) => f.versionId === v.id)) {
        const status = approvalOf(v)?.status;
        if (status !== 'approved' && status !== 'not-required')
          return problem(
            409,
            'approval_required',
            'An Admin must approve the executable content first',
          );
      }
      const given = await body().catch(() => undefined);
      const at = nowIso();
      v.status = 'published';
      v.publishedAt = at;
      v.updatedAt = at;
      e.status = 'published';
      e.currentVersionId = v.id;
      if (given?.visibility)
        e.visibility = {
          org: given.visibility.org ?? false,
          teamIds: given.visibility.teamIds ?? [],
          userIds: given.visibility.userIds ?? [],
        };
      e.updatedAt = at;
      return HttpResponse.json(v, { headers: etagHeaders(v.updatedAt) });
    },
    { allow: 'manage' },
  ),

  route.get('/catalog/{id}/versions/{vid}/overrides', ({ params }) => {
    const e = entryOf(params.id);
    const v = versionOf(params.id, params.vid);
    if (!e || !v) return notFound('Version');
    return HttpResponse.json(
      { doc: v.overrides, updatedAt: v.updatedAt, userOverrides: e.userOverrides, rejected: [] },
      { headers: etagHeaders(v.updatedAt) },
    );
  }),

  versionRoute.put(
    '/catalog/{id}/versions/{vid}/overrides',
    async ({ entry: e, version: v, request, body }) => {
      if (v.status !== 'draft')
        return problem(409, 'version_immutable', 'Published versions cannot be edited');
      const stale = checkVersion(request, v);
      if (stale) return stale;
      v.overrides = await body();
      v.updatedAt = nowIso();
      return HttpResponse.json(
        { doc: v.overrides, updatedAt: v.updatedAt, userOverrides: e.userOverrides, rejected: [] },
        { headers: etagHeaders(v.updatedAt) },
      );
    },
    { allow: 'manage' },
  ),

  route.get('/catalog/{id}/default-overrides', ({ params }) => {
    const e = entryOf(params.id);
    const v = e ? currentVersion(e) : undefined;
    if (!e) return notFound('Entry');
    if (!v) return problem(409, 'no_published_version', 'The entry has no published version yet');
    return HttpResponse.json(
      { doc: v.overrides, updatedAt: v.updatedAt, rejected: [] },
      { headers: etagHeaders(v.updatedAt) },
    );
  }),

  entryRoute.put(
    '/catalog/{id}/default-overrides',
    async ({ entry: e, request, body }) => {
      const v = currentVersion(e);
      if (!v) return problem(409, 'no_published_version', 'The entry has no published version yet');
      const stale = checkVersion(request, v);
      if (stale) return stale;
      v.overrides = await body();
      v.updatedAt = nowIso();
      return HttpResponse.json(
        { doc: v.overrides, updatedAt: v.updatedAt, rejected: [] },
        { headers: etagHeaders(v.updatedAt) },
      );
    },
    { allow: 'manage' },
  ),
];
