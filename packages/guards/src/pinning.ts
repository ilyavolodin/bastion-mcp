import { canonicalDigest, type DRIFT_POLICIES, type ITEM_KINDS } from '@bastion-mcp/core';
import { extractDefinitionSegments } from './extract';
import type { GuardPipeline, GuardRunResult, ProfileLayers } from './pipeline';
import type { InstallationRef, PrincipalRef } from './types';

/** Tool-definition pinning and description scanning (13.6). */

export type DefinitionKind = (typeof ITEM_KINDS)[number];
export type DriftPolicy = (typeof DRIFT_POLICIES)[number];

/** An upstream tool, prompt, resource or template definition as listed. */
export type Definition = {
  kind: DefinitionKind;
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
  /** Prompt arguments. */
  arguments?: unknown;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
};

/** Pin key to hex SHA-256. Stored on the catalog version (or the personal installation). */
export type PinSet = Record<string, string>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The key an item is tracked under: its name, or its URI for resources and templates. */
export const pinKey = (def: Definition): string => {
  const id =
    def.kind === 'resource'
      ? (def.uri ?? def.name)
      : def.kind === 'template'
        ? (def.uriTemplate ?? def.name)
        : def.name;
  return `${def.kind}:${id}`;
};

const pinnedFields = (def: Definition): Record<string, unknown> => {
  const ui = isRecord(def._meta) ? def._meta.ui : undefined;
  const fields: Record<string, unknown> = {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
    ui,
  };
  // Prompts, resources and templates carry more text an attacker could poison.
  if (def.kind !== 'tool') {
    fields.arguments = def.arguments;
    fields.uri = def.uri;
    fields.uriTemplate = def.uriTemplate;
    fields.mimeType = def.mimeType;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
};

/**
 * SHA-256 over RFC 8785 canonical JSON of name, title, description, inputSchema, outputSchema,
 * annotations and `_meta.ui` (13.6). Key order and `_meta` fields other than `ui` never change it.
 */
export const pinDefinition = (def: Definition): string =>
  canonicalDigest(pinnedFields(def)).toString('hex');

export const pinAll = (defs: readonly Definition[]): PinSet => {
  const pins: PinSet = {};
  for (const d of defs) {
    const key = pinKey(d);
    if (!(key in pins)) pins[key] = pinDefinition(d);
  }
  return pins;
};

export type DriftChange = 'added' | 'changed' | 'removed';

export type DriftItem = {
  key: string;
  kind: DefinitionKind;
  name: string;
  change: DriftChange;
  previousPin?: string;
  newPin?: string;
  /** Top-level pinned fields that differ, when the previous definition is known. */
  changedFields?: string[];
  before?: Definition;
  after?: Definition;
  /** Definition-phase guard results, attached by `attachScan`. */
  scan?: DefinitionScan;
};

/** What the review queue shows the owners (13.6): a definition diff plus the guard results. */
export type DriftReview = {
  status: 'open';
  onDrift: DriftPolicy;
  items: DriftItem[];
  summary: { added: number; changed: number; removed: number };
  /** `block`: the whole installation stays disabled until approved. */
  installationDisabled: boolean;
};

export type DriftResult = {
  /** True when there was no pin set: trust on first use (personal installations). */
  firstPin: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  items: DriftItem[];
  /** Keys the principal may see. */
  visibleKeys: string[];
  /** Keys hidden until approved (`hideChanged`). Removed items simply disappear. */
  hiddenKeys: string[];
  installationDisabled: boolean;
  /** `warn` policy: items stay visible but a review item is raised. */
  warn: boolean;
  review: DriftReview | null;
  /** The pin set to store: the new one on first use, otherwise the unchanged `pinSet`. */
  pinSet: PinSet;
};

const diffFields = (before: Definition, after: Definition): string[] => {
  const a = pinnedFields(before);
  const b = pinnedFields(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((k) => canonicalDigest(a[k] ?? null).compare(canonicalDigest(b[k] ?? null)) !== 0)
    .sort();
};

/**
 * Compares the current upstream list with the pin set (13.6). New and changed items follow `onDrift`:
 * `hideChanged` hides them until approved, `block` disables the whole installation, `warn` keeps them
 * visible. With no pin set (`null`) the current list becomes the pin set (trust on first use).
 */
export const computeDrift = (
  pinSet: PinSet | null,
  currentDefs: readonly Definition[],
  onDrift: DriftPolicy,
  previousDefs: readonly Definition[] = [],
): DriftResult => {
  const current = new Map<string, Definition>();
  for (const d of currentDefs) if (!current.has(pinKey(d))) current.set(pinKey(d), d);
  const allKeys = [...current.keys()];

  if (pinSet === null) {
    return {
      firstPin: true,
      added: [],
      changed: [],
      removed: [],
      items: [],
      visibleKeys: allKeys,
      hiddenKeys: [],
      installationDisabled: false,
      warn: false,
      review: null,
      pinSet: pinAll(currentDefs),
    };
  }

  const previous = new Map(previousDefs.map((d) => [pinKey(d), d]));
  const items: DriftItem[] = [];
  for (const [key, def] of current) {
    const newPin = pinDefinition(def);
    const old = pinSet[key];
    if (old === undefined) {
      items.push({ key, kind: def.kind, name: def.name, change: 'added', newPin, after: def });
    } else if (old !== newPin) {
      const before = previous.get(key);
      items.push({
        key,
        kind: def.kind,
        name: def.name,
        change: 'changed',
        previousPin: old,
        newPin,
        after: def,
        ...(before === undefined ? {} : { before, changedFields: diffFields(before, def) }),
      });
    }
  }
  for (const key of Object.keys(pinSet)) {
    if (current.has(key)) continue;
    const before = previous.get(key);
    const sep = key.indexOf(':');
    items.push({
      key,
      kind: (before?.kind ?? key.slice(0, sep)) as DefinitionKind,
      name: before?.name ?? key.slice(sep + 1),
      change: 'removed',
      previousPin: pinSet[key] as string,
      ...(before === undefined ? {} : { before }),
    });
  }

  const added = items.filter((i) => i.change === 'added').map((i) => i.key);
  const changed = items.filter((i) => i.change === 'changed').map((i) => i.key);
  const removed = items.filter((i) => i.change === 'removed').map((i) => i.key);
  const drifted = added.length + changed.length > 0;

  const hidden = new Set<string>();
  let installationDisabled = false;
  if (onDrift === 'hideChanged') for (const k of [...added, ...changed]) hidden.add(k);
  if (onDrift === 'block' && drifted) installationDisabled = true;

  const visibleKeys = installationDisabled ? [] : allKeys.filter((k) => !hidden.has(k));
  const needsReview = items.length > 0 && (drifted || onDrift !== 'block');
  const review: DriftReview | null = needsReview
    ? {
        status: 'open',
        onDrift,
        items,
        summary: { added: added.length, changed: changed.length, removed: removed.length },
        installationDisabled,
      }
    : null;

  return {
    firstPin: false,
    added,
    changed,
    removed,
    items,
    visibleKeys,
    hiddenKeys: installationDisabled ? allKeys : [...hidden],
    installationDisabled,
    warn: onDrift === 'warn' && items.length > 0,
    review,
    pinSet,
  };
};

/** Approving updates the pin set: approved new and changed items are pinned, approved removals dropped. */
export const approveDrift = (
  pinSet: PinSet,
  drift: Pick<DriftResult, 'items'>,
  approvedKeys: readonly string[],
): PinSet => {
  const next: PinSet = { ...pinSet };
  const approved = new Set(approvedKeys);
  for (const item of drift.items) {
    if (!approved.has(item.key)) continue;
    if (item.change === 'removed') delete next[item.key];
    else if (item.newPin !== undefined) next[item.key] = item.newPin;
  }
  return next;
};

// --- Description scanning ----------------------------------------------------------------------------------------

export type DefinitionScan = {
  result: GuardRunResult;
  /** A `malicious` verdict (or a blocking action) from any guard. */
  malicious: boolean;
};

export type ScanContext = {
  principal: PrincipalRef;
  installation: InstallationRef;
  method?: string;
};

const isMalicious = (result: GuardRunResult): boolean =>
  result.findings.some(
    (f) => f.finding.error !== true && (f.finding.verdict === 'malicious' || f.action === 'block'),
  );

/** Runs the definition-phase guards on one definition (13.6). */
export const scanDefinition = async (
  pipeline: GuardPipeline,
  def: Definition,
  ctx: ScanContext,
  layers: ProfileLayers,
): Promise<DefinitionScan> => {
  const result = await pipeline.run(
    {
      phase: 'definition',
      segments: extractDefinitionSegments(def),
      principal: ctx.principal,
      installation: ctx.installation,
      item: { kind: def.kind, name: def.name },
      method: ctx.method ?? 'definition/scan',
    },
    layers,
  );
  return { result, malicious: isMalicious(result) };
};

/** Definition-phase scan of a plugin or skill text file (25.3). */
export const scanTextFile = async (
  pipeline: GuardPipeline,
  file: { path: string; text: string },
  ctx: ScanContext,
  layers: ProfileLayers,
): Promise<DefinitionScan> => {
  const result = await pipeline.run(
    {
      phase: 'definition',
      segments: [{ path: 'file', text: file.text, contentType: 'file' }],
      principal: ctx.principal,
      installation: ctx.installation,
      item: { kind: 'file', name: file.path },
      method: ctx.method ?? 'plugin/scan',
    },
    layers,
  );
  return { result, malicious: isMalicious(result) };
};

/** Scans every item of a drift review and attaches the results (13.6). */
export const attachScans = async (
  pipeline: GuardPipeline,
  review: DriftReview,
  ctx: ScanContext,
  layers: ProfileLayers,
): Promise<DriftReview> => {
  const items: DriftItem[] = [];
  for (const item of review.items) {
    if (item.after === undefined) {
      items.push(item);
      continue;
    }
    items.push({ ...item, scan: await scanDefinition(pipeline, item.after, ctx, layers) });
  }
  return { ...review, items };
};

export type ApprovalStatus = {
  approvable: boolean;
  /** Why approval is blocked. */
  reason?: string;
  /** An admin override reason was recorded for a malicious verdict. */
  overridden: boolean;
};

/** A `malicious` verdict blocks approval unless an admin records an override reason (13.6). */
export const approvalStatus = (scan: DefinitionScan, overrideReason?: string): ApprovalStatus => {
  if (!scan.malicious) return { approvable: true, overridden: false };
  if (overrideReason !== undefined && overrideReason.trim() !== '') {
    return { approvable: true, overridden: true };
  }
  return {
    approvable: false,
    overridden: false,
    reason: 'a guard flagged this definition as malicious; an admin must record an override reason',
  };
};
