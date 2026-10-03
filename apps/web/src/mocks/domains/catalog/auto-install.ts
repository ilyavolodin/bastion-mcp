/** Auto-install policies: who gets an entry without asking, and the audience preview (11.5). */
import type { Res } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  route,
} from '../../http';
import { getDb, nextId } from '../../state';
import { nowIso } from '../../util';
import { data, entryOf, validation } from './store';
import type { Policy } from './types';

const needsPerUserSetup = (entryId: string): boolean => {
  const v = data().versions.find((x) => x.entryId === entryId && x.status === 'published');
  const mode = (v?.serverSpec?.auth as { mode?: string } | undefined)?.mode;
  return mode === 'userSecret' || mode === 'oauth';
};

/** Who an audience reaches, computed from the access slice like `computePreview` of the API (11.5). */
const previewOf = (
  entryId: string,
  p: Pick<Policy, 'target' | 'mode' | 'scope' | 'applyToExisting'>,
): Res<'post', '/auto-install-policies/{id}/preview'> => {
  const { users, teams } = getDb().data.access;
  const memberships = teams.flatMap((t) => t.members);
  const teamsOf = (userId: string) => memberships.filter((m) => m.userId === userId);
  const matched = users.filter((u) => {
    if (u.status === 'deactivated') return false;
    const t = p.target;
    if (t.all) return true;
    const mine = teamsOf(u.id);
    if (t.teamIds?.some((id) => mine.some((m) => m.teamId === id))) return true;
    if (
      t.roles?.some((r) =>
        r === 'manager' ? mine.some((m) => m.role === 'manager') : u.orgRole === r,
      )
    )
      return true;
    return false;
  });
  const byTeam = new Map<string, number>();
  for (const u of matched)
    for (const m of teamsOf(u.id)) byTeam.set(m.teamId, (byTeam.get(m.teamId) ?? 0) + 1);
  const willInstall = p.scope === 'team' ? byTeam.size : matched.length;
  const effective = p.applyToExisting || p.scope === 'team' ? willInstall : 0;
  const mustConnect = p.scope === 'user' && needsPerUserSetup(entryId) ? effective : 0;
  const summary = `${matched.length} ${matched.length === 1 ? 'person' : 'people'} in ${byTeam.size} ${byTeam.size === 1 ? 'team' : 'teams'} get this${
    mustConnect > 0 ? `; ${mustConnect} must connect their account` : ''
  }`;
  return {
    summary,
    users: matched.length,
    teams: byTeam.size,
    willInstall: effective,
    alreadyInstalled: 0,
    skippedRemoved: willInstall - effective,
    mustConnect,
    byTeam: [...byTeam].map(([teamId, n]) => ({
      teamId,
      slug: teams.find((t) => t.id === teamId)?.slug ?? null,
      users: n,
    })),
    sample: matched.slice(0, 12).map((u) => ({ userId: u.id, displayName: u.displayName })),
  };
};

export const autoInstallHandlers = [
  route.get(
    '/auto-install-policies',
    ({ url }) => {
      return HttpResponse.json(pageOf(data().autoInstall, url));
    },
    { allow: 'readConfig' },
  ),

  route.post(
    '/auto-install-policies',
    async ({ body }) => {
      const input = await body();
      const errors: { path: string; message: string }[] = [];
      if (!input.catalogEntryId || !entryOf(input.catalogEntryId))
        errors.push({ path: '/catalogEntryId', message: 'Pick an existing catalog entry' });
      const t = input.target;
      if (
        !t ||
        !(
          t.all === true ||
          (t.teamIds?.length ?? 0) + (t.roles?.length ?? 0) + (t.idpGroups?.length ?? 0) > 0
        )
      )
        errors.push({
          path: '/target',
          message: 'the target must name all users, teams, roles or IdP groups',
        });
      if (errors.length) return validation(errors);
      const at = nowIso();
      const p: Policy = {
        id: nextId('ap'),
        catalogEntryId: input.catalogEntryId,
        target: input.target,
        mode: input.mode ?? 'default',
        scope: input.scope ?? 'user',
        applyToExisting: input.applyToExisting ?? true,
        enabled: input.enabled ?? true,
        createdBy: getDb().me.id,
        createdAt: at,
        updatedAt: at,
      };
      data().autoInstall.push(p);
      return HttpResponse.json(p, { status: 201, headers: etagHeaders(at) });
    },
    { allow: 'manage' },
  ),

  route.patch(
    '/auto-install-policies/{id}',
    async ({ request, params, body }) => {
      const p = data().autoInstall.find((x) => x.id === params.id);
      if (!p) return notFound('Policy');
      const stale = checkVersion(request, p);
      if (stale) return stale;
      const patch = await body();
      if (Object.keys(patch).length === 0)
        return validation([{ path: '/', message: 'at least one field is required' }]);
      Object.assign(p, patch, { updatedAt: nowIso() });
      return HttpResponse.json(p, { headers: etagHeaders(p.updatedAt) });
    },
    { allow: 'manage' },
  ),

  route.delete(
    '/auto-install-policies/{id}',
    ({ request, params }) => {
      const p = data().autoInstall.find((x) => x.id === params.id);
      if (!p) return notFound('Policy');
      const stale = checkVersion(request, p);
      if (stale) return stale;
      data().autoInstall = data().autoInstall.filter((x) => x !== p);
      return noContent();
    },
    { allow: 'manage' },
  ),

  route.post(
    '/auto-install-policies/{id}/preview',
    async ({ params, body }) => {
      const p = data().autoInstall.find((x) => x.id === params.id);
      if (!p) return notFound('Policy');
      const changes = await body().catch(() => ({}));
      return HttpResponse.json(previewOf(p.catalogEntryId, { ...p, ...changes }));
    },
    { allow: 'manage' },
  ),
];
