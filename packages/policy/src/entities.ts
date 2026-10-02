import type { Context, EntityJson } from '@cedar-policy/cedar-wasm/nodejs';
import { entityKey } from './cedar';
import { NAMESPACE } from './schema';
import type {
  CatalogVisibility,
  InstallationData,
  McpRequestContext,
  PrincipalData,
  ResourceData,
  ToolAnnotations,
} from './types';

/** Strings in tool-argument tags are capped at this many characters (10.2). */
export const MAX_TAG_VALUE_LENGTH = 256;
/** Defensive bounds on a single call's tags; arguments beyond them are not visible to policies. */
export const MAX_TAGS = 64;
export const MAX_TAG_NAME_LENGTH = 128;

export const TOOL_CALL_ENTITY_ID = 'call';

type EntityRef = { __entity: { type: string; id: string } };

const typeName = (type: string): string => `${NAMESPACE}::${type}`;
const ref = (type: string, id: string): EntityRef => ({ __entity: { type: typeName(type), id } });

export type Slice = {
  entities: EntityJson[];
  /** `entityKey`s the entity is `in` (itself first), used to select policy shards. */
  ancestors: string[];
  uid: { type: string; id: string };
};

const entity = (
  type: string,
  id: string,
  attrs: Record<string, unknown>,
  parents: Array<[string, string]>,
): EntityJson => ({
  uid: { type: typeName(type), id },
  attrs: attrs as EntityJson['attrs'],
  parents: parents.map(([t, i]) => ({ type: typeName(t), id: i })),
});

// --- tool flags and call entity ----------------------------------------------------------------------

/** `readOnly`, `destructive` and `openWorld` from final annotations with the MCP defaults (10.2). */
export const deriveToolFlags = (
  annotations: ToolAnnotations | undefined,
): { readOnly: boolean; destructive: boolean; openWorld: boolean } => ({
  readOnly: annotations?.readOnlyHint ?? false,
  destructive: annotations?.destructiveHint ?? true,
  openWorld: annotations?.openWorldHint ?? true,
});

const tagValue = (value: unknown): string | null => {
  if (typeof value === 'string') return value.slice(0, MAX_TAG_VALUE_LENGTH);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
};

/**
 * The per-call `ToolCall` entity (10.2): top-level scalar arguments become String tags; strings are capped
 * at 256 characters; objects, arrays and null are not visible to policies.
 */
export const buildToolCallEntity = (args: Record<string, unknown> | undefined): EntityJson => {
  const tags: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(args ?? {})) {
    if (count >= MAX_TAGS) break;
    if (name.length === 0 || name.length > MAX_TAG_NAME_LENGTH) continue;
    const tag = tagValue(value);
    if (tag === null) continue;
    tags[name] = tag;
    count += 1;
  }
  return { ...entity('ToolCall', TOOL_CALL_ENTITY_ID, {}, []), tags };
};

// --- context -----------------------------------------------------------------------------------------

export const buildContext = (context: McpRequestContext, withCall: boolean): Context => ({
  clientId: context.clientId,
  clientName: context.clientName,
  ip: { __extn: { fn: 'ip', arg: context.ip } },
  authMethod: context.authMethod,
  hour: context.hour,
  weekday: context.weekday,
  endpoint: context.endpoint,
  ...(withCall ? { call: ref('ToolCall', TOOL_CALL_ENTITY_ID) } : {}),
});

/** `hour` and `weekday` of `now` in `timeZone` (UTC by default), as policies expect (10.3). */
export const clockContext = (now: Date, timeZone = 'UTC'): { hour: number; weekday: number } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  return { hour, weekday: Math.max(weekday, 0) };
};

// --- principals --------------------------------------------------------------------------------------

export const principalSlice = (principal: PrincipalData, orgId: string): Slice => {
  const orgKey = entityKey(typeName('Org'), orgId);
  if (principal.kind === 'service') {
    const team = principal.team;
    return {
      uid: { type: typeName('ServiceAccount'), id: principal.id },
      ancestors: [
        entityKey(typeName('ServiceAccount'), principal.id),
        entityKey(typeName('Team'), team.id),
        orgKey,
      ],
      entities: [
        entity('ServiceAccount', principal.id, { active: principal.active }, [
          ['Team', team.id],
          ['Org', orgId],
        ]),
        entity('Team', team.id, { slug: team.slug ?? team.id }, [['Org', orgId]]),
      ],
    };
  }
  const managed = principal.teams.filter((t) => t.role === 'manager');
  return {
    uid: { type: typeName('User'), id: principal.id },
    ancestors: [
      entityKey(typeName('User'), principal.id),
      ...principal.teams.map((t) => entityKey(typeName('Team'), t.id)),
      orgKey,
    ],
    entities: [
      entity(
        'User',
        principal.id,
        {
          role: principal.role,
          active: principal.active,
          emailDomain: principal.emailDomain,
          managedTeams: managed.map((t) => ref('Team', t.id)),
        },
        [...principal.teams.map((t): [string, string] => ['Team', t.id]), ['Org', orgId]],
      ),
      ...principal.teams.map((t) =>
        entity('Team', t.id, { slug: t.slug ?? t.id }, [['Org', orgId]]),
      ),
    ],
  };
};

// --- resources ---------------------------------------------------------------------------------------

/** `org`, `restricted` or `private`, derived from the visibility object (11.1). */
export const visibilitySummary = (visibility: CatalogVisibility | undefined): string => {
  if (visibility?.org) return 'org';
  if (visibility && (visibility.teamIds.length > 0 || visibility.userIds.length > 0)) {
    return 'restricted';
  }
  return 'private';
};

const installationEntities = (installation: InstallationData, orgId: string): EntityJson[] => {
  const entry = installation.catalogEntry;
  const owner = installation.ownerUserId
    ? 'user'
    : installation.ownerTeamId
      ? 'team'
      : installation.ownerServiceId
        ? 'service'
        : 'user';
  return [
    entity(
      'Installation',
      installation.id,
      {
        ...(installation.ownerUserId ? { ownerUser: ref('User', installation.ownerUserId) } : {}),
        ...(installation.ownerTeamId ? { ownerTeam: ref('Team', installation.ownerTeamId) } : {}),
        ...(installation.ownerServiceId
          ? { ownerService: ref('ServiceAccount', installation.ownerServiceId) }
          : {}),
        scope: owner,
      },
      [['CatalogEntry', installation.catalogEntryId]],
    ),
    ...(installation.ownerServiceId && installation.ownerServiceTeamId
      ? [
          entity('ServiceAccount', installation.ownerServiceId, { active: true }, [
            ['Team', installation.ownerServiceTeamId],
            ['Org', orgId],
          ]),
        ]
      : []),
    entity(
      'CatalogEntry',
      installation.catalogEntryId,
      {
        ...(entry?.ownerTeamId ? { ownerTeam: ref('Team', entry.ownerTeamId) } : {}),
        visibility: visibilitySummary(entry?.visibility),
        risk: entry?.risk ?? 'low',
      },
      [['Org', orgId]],
    ),
  ];
};

export const installationKey = (installation: InstallationData): string =>
  entityKey(typeName('Installation'), installation.id);

export const toolEntityId = (installationId: string, name: string): string =>
  `${installationId}/${name}`;

export const resourceSlice = (resource: ResourceData, orgId: string): Slice => {
  const orgKey = entityKey(typeName('Org'), orgId);
  const uid = (type: string, id: string) => ({ type: typeName(type), id });
  const key = (type: string, id: string) => entityKey(typeName(type), id);
  switch (resource.type) {
    case 'Org':
      return {
        uid: uid('Org', orgId),
        ancestors: [orgKey],
        entities: [entity('Org', orgId, {}, [])],
      };
    case 'Team':
      return {
        uid: uid('Team', resource.id),
        ancestors: [key('Team', resource.id), orgKey],
        entities: [
          entity('Team', resource.id, { slug: resource.slug ?? resource.id }, [['Org', orgId]]),
          entity('Org', orgId, {}, []),
        ],
      };
    case 'User':
      return {
        uid: uid('User', resource.id),
        ancestors: [
          key('User', resource.id),
          ...resource.teamIds.map((t) => key('Team', t)),
          orgKey,
        ],
        entities: [
          entity(
            'User',
            resource.id,
            {
              role: resource.role,
              active: resource.active,
              emailDomain: resource.emailDomain,
              managedTeams: resource.managedTeamIds.map((t) => ref('Team', t)),
            },
            [...resource.teamIds.map((t): [string, string] => ['Team', t]), ['Org', orgId]],
          ),
          ...resource.teamIds.map((t) => entity('Team', t, { slug: t }, [['Org', orgId]])),
        ],
      };
    case 'CatalogEntry':
      return {
        uid: uid('CatalogEntry', resource.id),
        ancestors: [key('CatalogEntry', resource.id), orgKey],
        entities: [
          entity(
            'CatalogEntry',
            resource.id,
            {
              ...(resource.ownerTeamId ? { ownerTeam: ref('Team', resource.ownerTeamId) } : {}),
              visibility: visibilitySummary(resource.visibility),
              risk: resource.risk,
            },
            [['Org', orgId]],
          ),
        ],
      };
    case 'Installation':
      return {
        uid: uid('Installation', resource.id),
        ancestors: [
          key('Installation', resource.id),
          key('CatalogEntry', resource.catalogEntryId),
          orgKey,
        ],
        entities: installationEntities(resource, orgId),
      };
    case 'Tool': {
      const id = toolEntityId(resource.installation.id, resource.name);
      const flags = deriveToolFlags(resource.annotations);
      return {
        uid: uid('Tool', id),
        ancestors: [
          key('Tool', id),
          installationKey(resource.installation),
          key('CatalogEntry', resource.installation.catalogEntryId),
          orgKey,
        ],
        entities: [
          entity('Tool', id, { name: resource.name, ...flags }, [
            ['Installation', resource.installation.id],
          ]),
          ...installationEntities(resource.installation, orgId),
        ],
      };
    }
    case 'Prompt': {
      const id = toolEntityId(resource.installation.id, resource.name);
      return {
        uid: uid('Prompt', id),
        ancestors: [
          key('Prompt', id),
          installationKey(resource.installation),
          key('CatalogEntry', resource.installation.catalogEntryId),
          orgKey,
        ],
        entities: [
          entity('Prompt', id, { name: resource.name }, [
            ['Installation', resource.installation.id],
          ]),
          ...installationEntities(resource.installation, orgId),
        ],
      };
    }
    case 'Resource': {
      const id = toolEntityId(resource.installation.id, resource.uri);
      return {
        uid: uid('Resource', id),
        ancestors: [
          key('Resource', id),
          installationKey(resource.installation),
          key('CatalogEntry', resource.installation.catalogEntryId),
          orgKey,
        ],
        entities: [
          entity('Resource', id, { uri: resource.uri }, [
            ['Installation', resource.installation.id],
          ]),
          ...installationEntities(resource.installation, orgId),
        ],
      };
    }
  }
};

/** Merges slices into one entity list, the first occurrence of an entity winning. */
export const mergeEntities = (lists: readonly EntityJson[][]): EntityJson[] => {
  const seen = new Set<string>();
  const out: EntityJson[] = [];
  for (const list of lists) {
    for (const e of list) {
      const uid = 'type' in e.uid ? e.uid : e.uid.__entity;
      const k = entityKey(uid.type, uid.id);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
};
