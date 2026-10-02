/**
 * What the catalog screens show, derived from the API rows: names joined from other lists, the letter and tint the
 * API does not store (`lib/avatar.ts`), target chips of auto-install policies and the review lines of executable
 * content. Everything else is the generated schema type itself.
 */
import { letterOf, tintOf } from '@/lib/avatar';
import type { Body, Res, Schemas } from '../schema';

export type CatalogEntry = Schemas['CatalogEntry'];
export type CatalogVersion = Schemas['CatalogVersion'];
export type CatalogVersionDetail = Schemas['CatalogVersionDetail'];
export type VersionTestRun = Schemas['VersionTestRun'];
export type CatalogFile = Schemas['CatalogFile'];
export type AutoInstallRow = Schemas['AutoInstallPolicy'];
export type AutoInstallPreview = Res<'post', '/auto-install-policies/{id}/preview'>;

export type AutoInstallTarget = NonNullable<Body<'post', '/auto-install-policies'>['target']>;
export type ServerSpecBody = NonNullable<Body<'post', '/catalog/{id}/versions'>['serverSpec']>;
export type InstallFormBody = NonNullable<Body<'post', '/catalog/{id}/versions'>['installForm']>;

/** Where the newest draft version of an entry stands with its automatic test (11.3). */
export type DraftTest = 'passed' | 'failed' | 'running' | 'untested';

export type CatalogEntryView = CatalogEntry & {
  letter: string;
  color: string;
  ownerTeamName: string | null;
  /** Label of the current published version, when the versions were loaded. */
  currentVersion: string | null;
  /** The newest draft version, when the entry has one (a draft entry always does once saved). */
  draftVersionId: string | null;
  draftLabel: string | null;
  draftTest: DraftTest | null;
  /** Installations other than hidden test installations; `null` when they could not be counted. */
  installations: number | null;
};

export const toEntryView = (
  entry: CatalogEntry,
  ctx: {
    teamNames: ReadonlyMap<string, string>;
    versions?: readonly CatalogVersion[] | undefined;
    installations?: number | null | undefined;
  },
): CatalogEntryView => {
  const draft = ctx.versions ? editableVersion(ctx.versions) : undefined;
  const draftVersion = draft?.status === 'draft' ? draft : undefined;
  const status = draftVersion?.testResult?.status;
  return {
    ...entry,
    letter: letterOf(entry.displayName),
    color: tintOf(entry.slug),
    ownerTeamName: entry.ownerTeamId ? (ctx.teamNames.get(entry.ownerTeamId) ?? null) : null,
    currentVersion: ctx.versions?.find((v) => v.id === entry.currentVersionId)?.label ?? null,
    draftVersionId: draftVersion?.id ?? null,
    draftLabel: draftVersion?.label ?? null,
    draftTest: draftVersion ? (status ?? 'untested') : null,
    installations: ctx.installations ?? null,
  };
};

/** The version the editor works on: the newest draft, else the newest version. */
export const editableVersion = (
  versions: readonly CatalogVersion[],
): CatalogVersion | undefined => {
  const newestFirst = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return newestFirst.find((v) => v.status === 'draft') ?? newestFirst[0];
};

/** `1.4.0` becomes `1.4.1`; labels that are not dotted numbers get `-next`. */
export const bumpLabel = (label: string): string => {
  const m = label.match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${label}-next`;
};

export const isPassing = (run: VersionTestRun | null | undefined): boolean =>
  run?.status === 'passed';

/** The ids the version test reports (11.2, 25.3), with a label for each. */
export const TEST_STEP_LABELS: Record<string, string> = {
  prepare: 'Prepare the instance',
  lockfile: 'Check the lockfile',
  connect: 'Connect to the server',
  snapshot: 'Capture tools, prompts and resources',
  scan: 'Scan every description',
  osv: 'Look up known vulnerabilities',
  era: 'Check both protocol eras',
  render: 'Render the plugin',
  'agent-plugins-schema': 'Validate the plugin manifest',
  'claude-validate': 'Validate with Claude Code',
  guards: 'Run the guards',
  classification: 'Classify the files',
  run: 'Run the test',
};

export const stepLabel = (id: string): string => TEST_STEP_LABELS[id] ?? id;

// --- auto-install ------------------------------------------------------------------------------------------

export type TargetChip = { type: 'all' | 'team' | 'role' | 'idpGroup'; id: string; label: string };

const roleLabel = (role: string) => `Role · ${role.charAt(0).toUpperCase()}${role.slice(1)}`;

/** One chip per audience of a policy target, as the policy screens list them. */
export const targetChips = (
  target: AutoInstallTarget,
  teamNames: ReadonlyMap<string, string>,
): TargetChip[] => [
  ...(target.all ? [{ type: 'all' as const, id: 'all', label: 'Everyone' }] : []),
  ...(target.teamIds ?? []).map((id) => ({
    type: 'team' as const,
    id,
    label: `Team · ${teamNames.get(id) ?? id}`,
  })),
  ...(target.roles ?? []).map((id) => ({ type: 'role' as const, id, label: roleLabel(id) })),
  ...(target.idpGroups ?? []).map((id) => ({
    type: 'idpGroup' as const,
    id,
    label: `Group · ${id}`,
  })),
];

export const chipsToTarget = (chips: readonly TargetChip[]): AutoInstallTarget => {
  const pick = (type: TargetChip['type']) => chips.filter((c) => c.type === type).map((c) => c.id);
  const teamIds = pick('team');
  const roles = pick('role');
  const idpGroups = pick('idpGroup');
  return {
    ...(chips.some((c) => c.type === 'all') ? { all: true } : {}),
    ...(teamIds.length ? { teamIds } : {}),
    ...(roles.length ? { roles: roles as NonNullable<AutoInstallTarget['roles']> } : {}),
    ...(idpGroups.length ? { idpGroups } : {}),
  };
};

export type AutoInstallView = AutoInstallRow & {
  entryName: string;
  targets: TargetChip[];
};

export const toAutoInstallView = (
  row: AutoInstallRow,
  ctx: { entryNames: ReadonlyMap<string, string>; teamNames: ReadonlyMap<string, string> },
): AutoInstallView => ({
  ...row,
  entryName: ctx.entryNames.get(row.catalogEntryId) ?? row.catalogEntryId,
  targets: targetChips(row.target, ctx.teamNames),
});

// --- executable approvals ------------------------------------------------------------------------------------

/** A plugin version waiting for an Admin (25.2): who wrote it and the diff lines to review. */
export type ExecutableApprovalView = {
  entryId: string;
  versionId: string;
  name: string;
  letter: string;
  color: string;
  author: string;
  summary: string;
  diff: string[];
};

const CHANGE_MARK = { added: '+', modified: '~', removed: '-' } as const;

export const toApprovalView = (
  entry: CatalogEntry,
  version: CatalogVersionDetail,
  authorName: string | undefined,
): ExecutableApprovalView => {
  const diff = version.approval?.diff ?? [];
  return {
    entryId: entry.id,
    versionId: version.id,
    name: `${entry.displayName} ${version.label}`,
    letter: letterOf(entry.displayName),
    color: tintOf(entry.slug),
    author: authorName ?? version.createdBy,
    summary: `${diff.length} executable ${diff.length === 1 ? 'file' : 'files'} to review`,
    diff: diff.flatMap((d) => [
      `${CHANGE_MARK[d.change]} ${d.path}`,
      ...(d.after ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => `+   ${line}`),
    ]),
  };
};
