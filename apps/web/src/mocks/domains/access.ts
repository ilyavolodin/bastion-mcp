/**
 * MSW mock of the access routes (users, teams, IdP group mapping, service accounts, OAuth client policies, tool
 * rules, custom Cedar policies, the simulator), typed by the generated OpenAPI types (see `../http.ts`). Rows are in
 * the shape of the API (`Schemas[...]`); `buildAccessData` seeds the Acme org, `accessHandlers` answer from
 * `getDb().data.access`.
 */
import { isValidSlug } from '@bastion-mcp/core/ids';
import type { Body, Res, Schemas } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
  type Sample,
  type SampleFactory,
} from '../http';
import { managesTeam } from '../roles';
import { ME_ID, PLATFORM_TEAM_ID, SEED_IDS, SEED_PEOPLE } from '../seed';
import { getDb, nextId } from '../state';
import { DAY, HOUR, iso, nowIso, validationFailed } from '../util';

export type AccessData = {
  users: Schemas['User'][];
  teams: Schemas['TeamDetail'][];
  roleMappingRules: Schemas['RoleMappingRule'][];
  serviceAccounts: Schemas['ServiceAccount'][];
  oauthClients: Schemas['OAuthClientPolicy'][];
  policyRules: Schemas['PolicyRule'][];
  customPolicies: Schemas['CustomPolicy'][];
};

// --- seed ---------------------------------------------------------------------------------------------------------

const TEAMS = [
  {
    id: PLATFORM_TEAM_ID,
    slug: 'platform',
    name: 'Platform team',
    idpGroup: null,
    members: SEED_PEOPLE.map(([id]) => id).filter((id) => !['u-jo', 'u-ana'].includes(id)),
    managers: [ME_ID],
  },
  {
    id: 't-data',
    slug: 'data-platform',
    name: 'Data platform',
    idpGroup: 'eng-data',
    members: ['u-raj', 'u-jo', 'u-li'],
    managers: ['u-raj'],
  },
  {
    id: 't-analytics',
    slug: 'analytics',
    name: 'Analytics',
    idpGroup: null,
    members: ['u-jo', 'u-sam'],
    managers: ['u-jo'],
  },
  {
    id: 't-support',
    slug: 'support',
    name: 'Support',
    idpGroup: 'eng-support',
    members: ['u-ana', 'u-eve', 'u-max'],
    managers: ['u-ana'],
  },
] as const;

export const CEDAR_SAMPLE = `// Support may read tickets but never post to Slack.
forbid (
  principal in Team::"support",
  action == Action::"callTool",
  resource in Server::"slack"
) when { resource.destructive == true };

permit (
  principal in Team::"data-platform",
  action == Action::"callTool",
  resource in Server::"pg-analytics"
);
`;

type SimBody = Body<'post', '/policies/simulate'>;
type SimResult = Res<'post', '/policies/simulate'>;
const slackTest: NonNullable<Body<'post', '/custom-policies'>['tests']>[number] = {
  name: 'Support cannot post to Slack',
  request: {
    principal: {
      kind: 'user',
      id: 'u-ana',
      role: 'member',
      teams: [{ id: 't-support', role: 'manager' }],
    },
    action: 'callTool',
    resource: {
      type: 'Tool',
      installation: {
        id: SEED_IDS.installation.slack,
        catalogEntryId: SEED_IDS.catalogEntry.slack,
      },
      name: 'slack_post_message',
    },
  },
  expect: 'deny',
};

export const buildAccessData = (now: number): AccessData => {
  const users: Schemas['User'][] = SEED_PEOPLE.map(([id, name, orgRole], i) => ({
    id,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.dev`,
    displayName: name,
    idpConnectionId: 'idp-1',
    externalSubject: `00u${id.slice(2)}`,
    scimExternalId: i % 2 === 0 ? null : `scim-${id.slice(2)}`,
    orgRole,
    status: 'active',
    catalogPublishOrgWide: id === ME_ID,
    // Three people have not connected an AI tool this week (home "Team adoption" card).
    lastLoginAt: [3, 8, 12].includes(i) ? iso(now - 12 * DAY) : iso(now - (i + 1) * HOUR),
    createdAt: iso(now - 90 * DAY),
    updatedAt: iso(now - 2 * DAY),
  }));
  const teams: Schemas['TeamDetail'][] = TEAMS.map((t) => ({
    id: t.id,
    slug: t.slug,
    displayName: t.name,
    idpGroup: t.idpGroup,
    createdAt: iso(now - 90 * DAY),
    updatedAt: iso(now - 5 * DAY),
    members: t.members.map((userId) => ({
      id: `${t.id}:${userId}`,
      teamId: t.id,
      userId,
      role: (t.managers as readonly string[]).includes(userId) ? 'manager' : 'member',
      source: 'manual',
      createdAt: iso(now - 80 * DAY),
      updatedAt: iso(now - 80 * DAY),
    })),
  }));
  const rule = (
    id: string,
    r: Pick<Schemas['PolicyRule'], 'name' | 'effect' | 'who' | 'what' | 'when'> &
      Partial<Pick<Schemas['PolicyRule'], 'ownerTeamId' | 'priority'>>,
  ): Schemas['PolicyRule'] => ({
    id,
    ownerTeamId: null,
    enabled: true,
    priority: 100,
    createdBy: ME_ID,
    createdAt: iso(now - 30 * DAY),
    updatedAt: iso(now - 3 * DAY),
    ...r,
  });
  return {
    users,
    teams,
    roleMappingRules: [
      {
        id: 'rm-1',
        idpConnectionId: 'idp-1',
        groupPattern: 'bastion-admins',
        mapsTo: { orgRole: 'admin' },
        priority: 10,
        createdAt: iso(now - 60 * DAY),
        updatedAt: iso(now - 60 * DAY),
      },
      {
        id: 'rm-2',
        idpConnectionId: 'idp-1',
        groupPattern: 'eng-(.*)',
        mapsTo: { createTeam: true, teamRole: 'member' },
        priority: 50,
        createdAt: iso(now - 60 * DAY),
        updatedAt: iso(now - 60 * DAY),
      },
      {
        id: 'rm-3',
        idpConnectionId: null,
        groupPattern: 'security-audit',
        mapsTo: { orgRole: 'auditor' },
        priority: 20,
        createdAt: iso(now - 40 * DAY),
        updatedAt: iso(now - 40 * DAY),
      },
    ],
    serviceAccounts: [
      {
        id: 'sa-1',
        teamId: PLATFORM_TEAM_ID,
        slug: 'ci-bot',
        displayName: 'ci-bot',
        status: 'active',
        oauthClientId: 'sa_x1Kq9mTz3pLw',
        authMethod: 'client_secret_basic',
        createdAt: iso(now - 60 * DAY),
        updatedAt: iso(now - 60 * DAY),
      },
      {
        id: 'sa-2',
        teamId: 't-support',
        slug: 'support-triage',
        displayName: 'support-triage',
        status: 'active',
        oauthClientId: 'sa_7QdfH2vNcA0e',
        authMethod: 'private_key_jwt',
        createdAt: iso(now - 20 * DAY),
        updatedAt: iso(now - 20 * DAY),
      },
    ],
    oauthClients: [
      {
        id: 'https://claude.ai/oauth/client.json',
        clientId: 'https://claude.ai/oauth/client.json',
        preApproved: true,
        blocked: false,
        updatedBy: ME_ID,
        updatedAt: iso(now - 30 * DAY),
      },
      {
        id: 'cursor-desktop',
        clientId: 'cursor-desktop',
        preApproved: true,
        blocked: false,
        updatedBy: ME_ID,
        updatedAt: iso(now - 20 * DAY),
      },
      {
        id: 'dcr-9f2c11',
        clientId: 'dcr-9f2c11',
        preApproved: false,
        blocked: false,
        updatedBy: null,
        updatedAt: iso(now - HOUR),
      },
    ],
    policyRules: [
      rule('support-no-destructive', {
        name: 'Support never posts to Slack',
        effect: 'forbid',
        ownerTeamId: 't-support',
        who: { teams: ['t-support'] },
        what: { installationId: SEED_IDS.installation.slack, toolName: 'slack_post_*' },
        when: {},
      }),
      rule('data-postgres', {
        name: 'Data teams use Postgres analytics',
        effect: 'permit',
        ownerTeamId: 't-data',
        who: { teams: ['t-data', 't-analytics'] },
        what: { installationId: SEED_IDS.installation.postgres, toolName: 'pg_*' },
        when: {},
      }),
      rule('no-github-delete', {
        name: 'Nobody deletes on GitHub',
        effect: 'forbid',
        who: {},
        what: { installationId: SEED_IDS.installation.github, toolName: 'delete_*' },
        when: {},
        priority: 10,
      }),
      rule('member-jira-hours', {
        name: 'Members transition Jira issues in office hours',
        effect: 'permit',
        who: { role: 'member' },
        what: { installationId: SEED_IDS.installation.jira, toolName: 'transition_issue' },
        when: { hours: { from: 8, to: 19 }, weekdays: [1, 2, 3, 4, 5] },
      }),
      rule('ci-bot-open-world', {
        name: 'ci-bot stays inside the network',
        effect: 'forbid',
        ownerTeamId: PLATFORM_TEAM_ID,
        who: { serviceAccounts: ['sa-1'] },
        what: { annotations: { openWorld: true } },
        when: { ipCidrs: ['10.0.0.0/8'] },
      }),
    ],
    customPolicies: [
      {
        id: 'cp-1',
        name: 'Support Slack guard',
        cedar: CEDAR_SAMPLE,
        tests: [slackTest],
        enabled: true,
        createdBy: ME_ID,
        createdAt: iso(now - 30 * DAY),
        updatedAt: iso(now - 10 * DAY),
      },
    ],
  };
};

// --- helpers ------------------------------------------------------------------------------------------------------

const data = () => getDb().data.access;

const stripMembers = ({ members: _members, ...team }: Schemas['TeamDetail']): Schemas['Team'] =>
  team;

const globMatch = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);

type SimPrincipal = SimBody['principal'];
type SimResource = SimBody['resource'];

const principalMatches = (who: Schemas['PolicyRule']['who'], p: SimPrincipal): boolean => {
  const entries = Object.entries(who ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return true;
  if (p.kind === 'service') {
    return (who?.serviceAccounts ?? []).includes(p.id) || (who?.teams ?? []).includes(p.team.id);
  }
  const teams = p.teams ?? [];
  return (
    (who?.role !== undefined &&
      (who.role === p.role ||
        (who.role === 'manager' && teams.some((t) => t.role === 'manager')))) ||
    (who?.teams ?? []).some((id) => teams.some((t) => t.id === id)) ||
    (who?.users ?? []).includes(p.id)
  );
};

const resourceMatches = (what: Schemas['PolicyRule']['what'], r: SimResource): boolean => {
  if (r.type !== 'Tool') return !what?.toolName;
  if (what?.installationId && what.installationId !== r.installation.id) return false;
  if (what?.catalogEntryId && what.catalogEntryId !== r.installation.catalogEntryId) return false;
  if (what?.toolName && !globMatch(what.toolName, r.name)) return false;
  if (what?.annotations?.destructive && !r.annotations?.destructiveHint) return false;
  if (what?.annotations?.openWorld && !r.annotations?.openWorldHint) return false;
  return true;
};

const ruleText = (r: Schemas['PolicyRule']): string =>
  `@id("rule-${r.id}")\n${r.effect} (principal, action == Action::"callTool", resource);`;

const simulate = (body: SimBody): SimResult => {
  const matched = data().policyRules.filter(
    (r) =>
      r.enabled &&
      principalMatches(r.who, body.principal) &&
      resourceMatches(r.what, body.resource),
  );
  const forbids = matched.filter((r) => r.effect === 'forbid');
  if (forbids.length > 0) {
    return {
      decision: 'deny',
      reasons: forbids.map((r) => `rule-${r.id}`),
      errors: [],
      determiningPolicies: forbids.map((r) => ({ id: `rule-${r.id}`, text: ruleText(r) })),
    };
  }
  const permits = matched.filter((r) => r.effect === 'permit');
  if (permits.length > 0) {
    return {
      decision: 'allow',
      reasons: permits.map((r) => `rule-${r.id}`),
      errors: [],
      determiningPolicies: permits.map((r) => ({ id: `rule-${r.id}`, text: ruleText(r) })),
    };
  }
  return {
    decision: 'allow',
    reasons: ['role.member.call'],
    errors: [],
    determiningPolicies: [
      {
        id: 'role.member.call',
        text: '@id("role.member.call")\npermit (principal, action == Action::"callTool", resource);',
      },
    ],
  };
};

/** The mock's stand-in for the Cedar validator: balanced parentheses, a permit or forbid, a closing `;`. */
const validateCedar = (cedar: string): string[] => {
  const errors: string[] = [];
  const open = (cedar.match(/\(/g) ?? []).length;
  const close = (cedar.match(/\)/g) ?? []).length;
  if (open !== close) errors.push('Unbalanced parentheses');
  if (!/\b(permit|forbid)\b/.test(cedar)) errors.push('A policy starts with permit or forbid');
  if (
    !/;\s*$/.test(
      cedar
        .trim()
        .replace(/\/\/.*$/gm, '')
        .trim(),
    )
  )
    errors.push('A policy ends with ;');
  return errors;
};

// --- handlers -----------------------------------------------------------------------------------------------------

export const accessHandlers = [
  route.get(
    '/users',
    ({ url }) => {
      const text = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = data().users.filter(
        (u) => !text || `${u.displayName} ${u.email}`.toLowerCase().includes(text),
      );
      return HttpResponse.json(pageOf(items, url));
    },
    { allow: 'readConfig' },
  ),
  route.patch(
    '/users/{id}',
    async ({ request, params, body }) => {
      const user = data().users.find((u) => u.id === params.id);
      if (!user) return notFound('User');
      const stale = checkVersion(request, user);
      if (stale) return stale;
      const patch = await body();
      // The last active Admin keeps the role (as the API does, 409 `last_admin`).
      const admins = data().users.filter((u) => u.orgRole === 'admin' && u.status === 'active');
      if (
        patch.orgRole !== undefined &&
        patch.orgRole !== 'admin' &&
        user.orgRole === 'admin' &&
        !admins.some((a) => a.id !== user.id)
      ) {
        return problem(
          409,
          'last_admin',
          'Conflict',
          'this is the last active administrator: make somebody else an administrator first',
        );
      }
      Object.assign(user, patch, { updatedAt: nowIso() });
      return HttpResponse.json(user, { headers: etagHeaders(user.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.post(
    '/users/{id}/deactivate',
    ({ params }) => {
      const user = data().users.find((u) => u.id === params.id);
      if (!user) return notFound('User');
      user.status = 'deactivated';
      user.updatedAt = nowIso();
      return HttpResponse.json(user);
    },
    { allow: 'admin' },
  ),

  route.get(
    '/teams',
    ({ url }) => {
      return HttpResponse.json(pageOf(data().teams.map(stripMembers), url));
    },
    { allow: 'readConfig' },
  ),
  route.get(
    '/teams/{id}',
    ({ params }) => {
      const team = data().teams.find((t) => t.id === params.id);
      if (!team) return notFound('Team');
      return HttpResponse.json(team, { headers: etagHeaders(team.updatedAt) });
    },
    { allow: 'readConfig' },
  ),
  route.post(
    '/teams',
    async ({ body }) => {
      const input = await body();
      const errors: { path: string; message: string }[] = [];
      if (!input.displayName?.trim()) errors.push({ path: '/displayName', message: 'required' });
      if (!input.slug || !isValidSlug(input.slug)) {
        errors.push({ path: '/slug', message: 'use lowercase letters, digits and dashes' });
      }
      if (errors.length > 0) return validationFailed(errors);
      if (data().teams.some((t) => t.slug === input.slug)) {
        return problem(409, 'conflict', 'Conflict', 'a team with this slug already exists');
      }
      const at = nowIso();
      const team: Schemas['TeamDetail'] = {
        id: nextId('t'),
        slug: input.slug,
        displayName: input.displayName.trim(),
        idpGroup: input.idpGroup ?? null,
        createdAt: at,
        updatedAt: at,
        members: [],
      };
      data().teams.push(team);
      return HttpResponse.json(stripMembers(team), { status: 201 });
    },
    { allow: 'admin' },
  ),
  route.put('/teams/{id}/members/{userId}', async ({ request, params, body, waiveVersion }) => {
    const team = data().teams.find((t) => t.id === params.id);
    if (!team || !data().users.some((u) => u.id === params.userId)) return notFound('Team or user');
    if (!managesTeam(team.id)) return forbidden();
    // Adding a person creates the membership: there is no version to name yet (17.1).
    const existing = team.members.find((m) => m.userId === params.userId);
    if (!existing) waiveVersion();
    const stale = existing ? checkVersion(request, existing) : null;
    if (stale) return stale;
    const input = await body();
    const at = nowIso();
    const member: Schemas['TeamMember'] = {
      id: `${team.id}:${params.userId}`,
      teamId: team.id,
      userId: params.userId,
      role: input.role ?? 'member',
      source: 'manual',
      createdAt: at,
      updatedAt: at,
    };
    team.members = team.members.filter((m) => m.userId !== params.userId).concat(member);
    return HttpResponse.json(member, { headers: etagHeaders(member.updatedAt) });
  }),
  route.delete('/teams/{id}/members/{userId}', ({ request, params }) => {
    const team = data().teams.find((t) => t.id === params.id);
    if (!team) return notFound('Team');
    if (!managesTeam(team.id)) return forbidden();
    const member = team.members.find((m) => m.userId === params.userId);
    if (!member) return notFound('Membership');
    const stale = checkVersion(request, member);
    if (stale) return stale;
    team.members = team.members.filter((m) => m.userId !== params.userId);
    return noContent();
  }),

  route.get('/role-mapping-rules', ({ url }) =>
    HttpResponse.json(pageOf(data().roleMappingRules, url)),
  ),
  route.post(
    '/role-mapping-rules',
    async ({ body }) => {
      const input = await body();
      if (!input.groupPattern?.trim()) {
        return validationFailed([{ path: '/groupPattern', message: 'required' }]);
      }
      const at = nowIso();
      const rule: Schemas['RoleMappingRule'] = {
        id: nextId('rm'),
        idpConnectionId: input.idpConnectionId ?? null,
        groupPattern: input.groupPattern,
        mapsTo: input.mapsTo,
        priority: input.priority ?? 100,
        createdAt: at,
        updatedAt: at,
      };
      data().roleMappingRules.push(rule);
      return HttpResponse.json(rule, { status: 201 });
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/role-mapping-rules/{id}',
    async ({ request, params, body }) => {
      const rule = data().roleMappingRules.find((r) => r.id === params.id);
      if (!rule) return notFound('Rule');
      const stale = checkVersion(request, rule);
      if (stale) return stale;
      Object.assign(rule, await body(), { updatedAt: nowIso() });
      return HttpResponse.json(rule, { headers: etagHeaders(rule.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.delete(
    '/role-mapping-rules/{id}',
    ({ request, params }) => {
      const d = data();
      const row = d.roleMappingRules.find((r) => r.id === params.id);
      if (!row) return notFound('Rule');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      d.roleMappingRules = d.roleMappingRules.filter((r) => r.id !== params.id);
      return noContent();
    },
    { allow: 'admin' },
  ),

  route.get('/service-accounts', ({ url }) => {
    const team = url.searchParams.get('teamId');
    const items = data().serviceAccounts.filter((s) => !team || s.teamId === team);
    return HttpResponse.json(pageOf(items, url));
  }),
  route.post('/service-accounts', async ({ body }) => {
    const input = await body();
    const errors: { path: string; message: string }[] = [];
    if (!input.displayName?.trim()) errors.push({ path: '/displayName', message: 'required' });
    if (!input.slug || !isValidSlug(input.slug)) {
      errors.push({ path: '/slug', message: 'use lowercase letters, digits and dashes' });
    }
    if (input.authMethod === 'private_key_jwt' && !input.jwks?.length) {
      errors.push({ path: '/jwks', message: 'required' });
    }
    if (errors.length > 0) return validationFailed(errors);
    const team = data().teams.find((t) => t.id === input.teamId);
    if (!team) return notFound('Team');
    if (!managesTeam(team.id)) return forbidden();
    if (data().serviceAccounts.some((s) => s.teamId === team.id && s.slug === input.slug)) {
      return problem(409, 'conflict', 'Conflict', 'a service account with this slug exists');
    }
    const authMethod = input.authMethod ?? 'client_secret_basic';
    const clientId = `sa_${nextId('c')}`;
    const at = nowIso();
    const account: Schemas['ServiceAccount'] = {
      id: nextId('sa'),
      teamId: team.id,
      slug: input.slug,
      displayName: input.displayName.trim(),
      status: 'active',
      oauthClientId: clientId,
      authMethod,
      createdAt: at,
      updatedAt: at,
    };
    data().serviceAccounts.push(account);
    return HttpResponse.json(
      {
        ...account,
        clientId,
        ...(authMethod === 'client_secret_basic' ? { clientSecret: `bsec_${nextId('s')}` } : {}),
      },
      { status: 201 },
    );
  }),
  route.post('/service-accounts/{id}/credentials', async ({ params, body }) => {
    const account = data().serviceAccounts.find((s) => s.id === params.id);
    if (!account) return notFound('Service account');
    const input = await body();
    const secret = account.authMethod === 'client_secret_basic' && !input?.jwks;
    return HttpResponse.json({
      clientId: account.oauthClientId ?? '',
      authMethod: account.authMethod,
      ...(secret ? { clientSecret: `bsec_${nextId('s')}` } : {}),
    });
  }),
  route.delete('/service-accounts/{id}', ({ request, params }) => {
    const d = data();
    const row = d.serviceAccounts.find((s) => s.id === params.id);
    if (!row) return notFound('Service account');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    d.serviceAccounts = d.serviceAccounts.filter((s) => s.id !== params.id);
    return noContent();
  }),

  route.get(
    '/oauth-clients',
    ({ url }) => {
      return HttpResponse.json(pageOf(data().oauthClients, url));
    },
    { allow: 'admin' },
  ),
  route.post(
    '/oauth-clients',
    async ({ body }) => {
      const input = await body();
      if (!input.clientId?.trim())
        return validationFailed([{ path: '/clientId', message: 'required' }]);
      if (data().oauthClients.some((c) => c.clientId === input.clientId)) {
        return problem(409, 'conflict', 'Conflict', 'this client already has a policy');
      }
      const client: Schemas['OAuthClientPolicy'] = {
        id: input.clientId,
        clientId: input.clientId,
        preApproved: input.preApproved ?? false,
        blocked: input.blocked ?? false,
        updatedBy: getDb().me.id,
        updatedAt: nowIso(),
      };
      data().oauthClients.push(client);
      return HttpResponse.json(client, { status: 201 });
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/oauth-clients/{id}',
    async ({ request, params, body }) => {
      const client = data().oauthClients.find((c) => c.id === params.id);
      if (!client) return notFound('Client');
      const stale = checkVersion(request, client);
      if (stale) return stale;
      Object.assign(client, await body(), { updatedAt: nowIso(), updatedBy: getDb().me.id });
      return HttpResponse.json(client, { headers: etagHeaders(client.updatedAt) });
    },
    { allow: 'admin' },
  ),

  route.get('/policy-rules', ({ url }) => HttpResponse.json(pageOf(data().policyRules, url))),
  route.post(
    '/policy-rules',
    async ({ body }) => {
      const input = await body();
      if (!input.name?.trim()) return validationFailed([{ path: '/name', message: 'required' }]);
      const at = nowIso();
      const rule: Schemas['PolicyRule'] = {
        id: nextId('pr'),
        name: input.name.trim(),
        ownerTeamId: input.ownerTeamId ?? null,
        effect: input.effect,
        who: input.who ?? {},
        what: input.what ?? {},
        when: input.when ?? {},
        enabled: input.enabled ?? true,
        priority: input.priority ?? 100,
        createdBy: getDb().me.id,
        createdAt: at,
        updatedAt: at,
      };
      data().policyRules.unshift(rule);
      return HttpResponse.json(rule, { status: 201 });
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/policy-rules/{id}',
    async ({ request, params, body }) => {
      const rule = data().policyRules.find((r) => r.id === params.id);
      if (!rule) return notFound('Rule');
      const stale = checkVersion(request, rule);
      if (stale) return stale;
      Object.assign(rule, await body(), { updatedAt: nowIso() });
      return HttpResponse.json(rule, { headers: etagHeaders(rule.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.delete(
    '/policy-rules/{id}',
    ({ request, params }) => {
      const d = data();
      const row = d.policyRules.find((r) => r.id === params.id);
      if (!row) return notFound('Rule');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      d.policyRules = d.policyRules.filter((r) => r.id !== params.id);
      return noContent();
    },
    { allow: 'admin' },
  ),

  route.get(
    '/custom-policies',
    ({ url }) => {
      return HttpResponse.json(pageOf(data().customPolicies, url));
    },
    { allow: 'admin' },
  ),
  route.post(
    '/custom-policies',
    async ({ body }) => {
      const input = await body();
      const errors = [
        ...(input.name?.trim() ? [] : [{ path: '/name', message: 'required' }]),
        ...validateCedar(input.cedar ?? '').map((message) => ({ path: '/cedar', message })),
        ...((input.tests ?? []).length === 0
          ? [{ path: '/tests', message: 'At least one test case is required' }]
          : []),
      ];
      if (errors.length > 0) return validationFailed(errors);
      const at = nowIso();
      const policy: Schemas['CustomPolicy'] = {
        id: nextId('cp'),
        name: input.name.trim(),
        cedar: input.cedar,
        tests: input.tests,
        enabled: input.enabled ?? true,
        createdBy: getDb().me.id,
        createdAt: at,
        updatedAt: at,
      };
      data().customPolicies.push(policy);
      return HttpResponse.json(policy, { status: 201 });
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/custom-policies/{id}',
    async ({ request, params, body }) => {
      const policy = data().customPolicies.find((p) => p.id === params.id);
      if (!policy) return notFound('Policy');
      const stale = checkVersion(request, policy);
      if (stale) return stale;
      const patch = await body();
      if (patch.cedar !== undefined) {
        const errors = validateCedar(patch.cedar).map((message) => ({ path: '/cedar', message }));
        if (errors.length > 0) return validationFailed(errors);
      }
      Object.assign(policy, patch, { updatedAt: nowIso() });
      return HttpResponse.json(policy, { headers: etagHeaders(policy.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.delete(
    '/custom-policies/{id}',
    ({ request, params }) => {
      const d = data();
      const row = d.customPolicies.find((p) => p.id === params.id);
      if (!row) return notFound('Policy');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      d.customPolicies = d.customPolicies.filter((p) => p.id !== params.id);
      return noContent();
    },
    { allow: 'admin' },
  ),

  route.post(
    '/policies/validate',
    async ({ body }) => {
      const { cedar, tests = [] } = await body();
      const errors = validateCedar(cedar);
      if (errors.length === 0 && tests.length === 0)
        errors.push('At least one test case is required');
      if (errors.length > 0) return HttpResponse.json({ ok: false, errors, tests: [] });
      const results = tests.map((t) => {
        const actual = simulate(t.request).decision;
        return {
          name: t.name,
          passed: actual === t.expect,
          expected: t.expect,
          actual,
          reasons: [],
        };
      });
      return HttpResponse.json({ ok: results.every((r) => r.passed), errors: [], tests: results });
    },
    { allow: 'admin' },
  ),
  route.post(
    '/policies/simulate',
    async ({ body }) => {
      return HttpResponse.json(simulate(await body()));
    },
    { allow: 'admin' },
  ),
];

// --- samples (one valid call per route, checked against the OpenAPI document) -----------------------------------

export const accessSamples: SampleFactory = (db) => {
  const a = db.data.access;
  const sim: SimBody = slackTest.request;
  const samples: Sample[] = [
    { method: 'get', path: '/users' },
    {
      method: 'patch',
      path: '/users/u-raj',
      body: { orgRole: 'auditor' } satisfies Body<'patch', '/users/{id}'>,
    },
    { method: 'post', path: '/users/u-tom/deactivate' },
    { method: 'get', path: '/teams' },
    { method: 'get', path: `/teams/${a.teams[0]?.id}` },
    {
      method: 'post',
      path: '/teams',
      body: { slug: 'security', displayName: 'Security', idpGroup: null } satisfies Body<
        'post',
        '/teams'
      >,
    },
    {
      method: 'put',
      path: '/teams/t-analytics/members/u-ana',
      body: { role: 'member' } satisfies Body<'put', '/teams/{id}/members/{userId}'>,
    },
    { method: 'delete', path: '/teams/t-analytics/members/u-sam' },
    { method: 'get', path: '/role-mapping-rules' },
    {
      method: 'post',
      path: '/role-mapping-rules',
      body: {
        idpConnectionId: null,
        groupPattern: 'sec-.*',
        mapsTo: { teamId: PLATFORM_TEAM_ID, teamRole: 'member' },
        priority: 30,
      } satisfies Body<'post', '/role-mapping-rules'>,
    },
    {
      method: 'patch',
      path: '/role-mapping-rules/rm-1',
      body: { priority: 5 } satisfies Body<'patch', '/role-mapping-rules/{id}'>,
    },
    { method: 'delete', path: '/role-mapping-rules/rm-3' },
    { method: 'get', path: '/service-accounts' },
    {
      method: 'post',
      path: '/service-accounts',
      body: {
        teamId: 't-data',
        slug: 'etl-runner',
        displayName: 'ETL runner',
        authMethod: 'client_secret_basic',
      } satisfies Body<'post', '/service-accounts'>,
    },
    { method: 'post', path: '/service-accounts/sa-1/credentials', body: {} },
    { method: 'delete', path: '/service-accounts/sa-2' },
    { method: 'get', path: '/oauth-clients' },
    {
      method: 'post',
      path: '/oauth-clients',
      body: { clientId: 'vscode-desktop', preApproved: true, blocked: false } satisfies Body<
        'post',
        '/oauth-clients'
      >,
    },
    {
      method: 'patch',
      path: '/oauth-clients/dcr-9f2c11',
      body: { preApproved: true } satisfies Body<'patch', '/oauth-clients/{id}'>,
    },
    { method: 'get', path: '/policy-rules' },
    {
      method: 'post',
      path: '/policy-rules',
      body: {
        name: 'Block deletes',
        ownerTeamId: null,
        effect: 'forbid',
        who: {},
        what: { toolName: 'delete_*' },
        when: {},
        enabled: true,
        priority: 100,
      } satisfies Body<'post', '/policy-rules'>,
    },
    {
      method: 'patch',
      path: '/policy-rules/data-postgres',
      body: { enabled: false } satisfies Body<'patch', '/policy-rules/{id}'>,
    },
    { method: 'delete', path: '/policy-rules/ci-bot-open-world' },
    { method: 'get', path: '/custom-policies' },
    {
      method: 'post',
      path: '/custom-policies',
      body: {
        name: 'Allow everything',
        cedar: 'permit (principal, action, resource);',
        tests: [slackTest],
        enabled: true,
      } satisfies Body<'post', '/custom-policies'>,
    },
    {
      method: 'patch',
      path: '/custom-policies/cp-1',
      body: { enabled: false } satisfies Body<'patch', '/custom-policies/{id}'>,
    },
    { method: 'delete', path: '/custom-policies/cp-1' },
    {
      method: 'post',
      path: '/policies/validate',
      body: { cedar: CEDAR_SAMPLE, tests: [slackTest] } satisfies Body<
        'post',
        '/policies/validate'
      >,
    },
    { method: 'post', path: '/policies/simulate', body: sim },
  ];
  return samples;
};
