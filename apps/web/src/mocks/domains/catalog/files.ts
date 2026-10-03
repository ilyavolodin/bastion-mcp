/** Catalog files of skills and plugins: executable approval (25.2), listing, reading and writing a file. */
import type { Schemas } from '@/api/schema';
import { checkVersion, etagHeaders, HttpResponse, notFound, problem, route } from '../../http';
import { getDb } from '../../state';
import { nowIso } from '../../util';
import { data, validation, versionRoute } from './store';
import type { FileRecord, Version } from './types';

/** Files of a plugin or skill version (25.2): who must approve, and the diff against the last approved version. */
export const approvalOf = (v: Version): Schemas['CatalogVersionDetail']['approval'] => {
  const executables = data().files.filter(
    (f) => f.versionId === v.id && f.classification === 'executable',
  );
  const stored = data().approvals[v.id];
  return {
    status: executables.length === 0 ? 'not-required' : stored ? 'approved' : 'pending',
    reviewedDiffSha256: 'a'.repeat(64),
    executables: executables.map((f) => ({ path: f.path })),
    diff: executables.map((f) => ({ path: f.path, change: 'added' as const, after: f.content })),
  };
};

export const fileRow = (f: FileRecord): Schemas['CatalogFile'] => ({
  id: `${f.versionId}:${f.path}`,
  path: f.path,
  mode: f.mode,
  classification: f.classification,
  sha256: '0'.repeat(64),
  size: f.content.length,
  updatedAt: f.updatedAt,
});

export const fileHandlers = [
  versionRoute.post(
    '/catalog/{id}/versions/{vid}/approve-executable',
    ({ version: v }) => {
      const executables = data().files.filter(
        (f) => f.versionId === v.id && f.classification === 'executable',
      );
      if (executables.length === 0)
        return problem(409, 'approval_not_required', 'This version has no executable content');
      const at = nowIso();
      data().approvals[v.id] = { approvedBy: getDb().me.id, approvedAt: at, note: null };
      return HttpResponse.json({
        id: v.id,
        updatedAt: at,
        catalogVersionId: v.id,
        approvedBy: getDb().me.id,
        reviewedDiffSha256: 'a'.repeat(64),
        note: null,
        approvedAt: at,
        status: 'approved' as const,
        paths: executables.map((f) => f.path),
      });
    },
    { allow: 'admin' },
  ),

  versionRoute.get(
    '/catalog/{id}/versions/{vid}/files',
    ({ version: v }) => {
      const files = data().files.filter((f) => f.versionId === v.id);
      return HttpResponse.json({
        items: files.map(fileRow).sort((a, b) => a.path.localeCompare(b.path)),
        nextCursor: null,
        approval: files.length ? (approvalOf(v) ?? null) : null,
      });
    },
    { allow: 'readConfig' },
  ),

  route.get(
    '/catalog/{id}/versions/{vid}/files/{path}',
    ({ params, request }) => {
      const path = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/files\//, ''));
      const f = data().files.find((x) => x.versionId === params.vid && x.path === path);
      return f
        ? HttpResponse.json(
            {
              ...fileRow(f),
              contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(f.content))),
            },
            { headers: etagHeaders(f.updatedAt) },
          )
        : notFound('File');
    },
    { allow: 'readConfig' },
  ),

  versionRoute.put(
    '/catalog/{id}/versions/{vid}/files/{path}',
    async ({ version: v, request, body, waiveVersion }) => {
      if (v.status !== 'draft')
        return problem(409, 'version_immutable', 'Published versions cannot be edited');
      const path = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/files\//, ''));
      const input = await body();
      if (typeof input.contentBase64 !== 'string')
        return validation([{ path: '/contentBase64', message: 'Required' }]);
      const content = new TextDecoder().decode(
        Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0)),
      );
      const mode = input.mode ?? 'file';
      const at = nowIso();
      const existing = data().files.find((x) => x.versionId === v.id && x.path === path);
      // A new file has no version to name yet (17.1).
      if (!existing) waiveVersion();
      const stale = existing ? checkVersion(request, existing) : null;
      if (stale) return stale;
      const record: FileRecord = {
        versionId: v.id,
        path,
        mode,
        classification:
          mode === 'executable' || existing?.classification === 'executable'
            ? 'executable'
            : 'plain',
        content,
        updatedAt: at,
      };
      data().files = [...data().files.filter((x) => x !== existing), record];
      delete data().approvals[v.id]; // a changed file must be reviewed again (25.2)
      return HttpResponse.json(fileRow(record), { headers: etagHeaders(at) });
    },
    { allow: 'manage' },
  ),
];
