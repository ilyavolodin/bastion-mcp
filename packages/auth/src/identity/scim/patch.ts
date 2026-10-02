import { z } from 'zod';
import { SCIM_SCHEMAS, ScimError } from './types';

const operationSchema = z.object({
  op: z.string().transform((s) => s.toLowerCase()),
  path: z.string().optional(),
  value: z.unknown().optional(),
});

const patchSchema = z.object({
  schemas: z.array(z.string()).refine((s) => s.includes(SCIM_SCHEMAS.patch)),
  Operations: z.array(operationSchema).min(1).max(100),
});

export type PatchOperation = {
  op: 'add' | 'replace' | 'remove';
  path: string | undefined;
  value: unknown;
};

export const parsePatchOps = (body: unknown): PatchOperation[] => {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ScimError(400, 'invalid PatchOp request', 'invalidSyntax');
  return parsed.data.Operations.map((o) => {
    if (o.op !== 'add' && o.op !== 'replace' && o.op !== 'remove') {
      throw new ScimError(400, `unsupported operation ${o.op}`, 'invalidSyntax');
    }
    return { op: o.op, path: o.path, value: o.value };
  });
};

/** Okta sends booleans, Entra sends "True" / "False" strings. */
export const toBoolean = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw new ScimError(400, 'expected a boolean value', 'invalidValue');
};

const asString = (v: unknown, what: string): string => {
  if (typeof v === 'string') return v;
  throw new ScimError(400, `${what} must be a string`, 'invalidValue');
};

export type UserDraft = {
  userName: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
  givenName: string | null;
  familyName: string | null;
  /** True once a patch touched a name part without setting displayName explicitly. */
  nameTouched: boolean;
};

const setAttribute = (draft: UserDraft, path: string, value: unknown): void => {
  switch (path.toLowerCase()) {
    case 'active':
      draft.active = toBoolean(value);
      return;
    case 'username':
      draft.userName = asString(value, 'userName').trim().toLowerCase();
      return;
    case 'displayname':
      draft.displayName = asString(value, 'displayName').trim();
      draft.nameTouched = false;
      return;
    case 'externalid':
      draft.externalId = value === null ? null : asString(value, 'externalId');
      return;
    case 'name.givenname':
      draft.givenName = asString(value, 'name.givenName');
      draft.nameTouched = true;
      return;
    case 'name.familyname':
      draft.familyName = asString(value, 'name.familyName');
      draft.nameTouched = true;
      return;
    default:
      // Unknown or unsupported attributes (emails, phoneNumbers, enterprise extension) are accepted and ignored
      // so IdP provisioning does not fail on attributes Bastion does not store.
      return;
  }
};

/** Applies User PATCH operations to a draft (path form and Okta's value-object form). */
export const applyUserPatch = (draft: UserDraft, ops: readonly PatchOperation[]): UserDraft => {
  const next = { ...draft };
  for (const op of ops) {
    if (op.op === 'remove') {
      if (op.path?.toLowerCase() === 'externalid') next.externalId = null;
      continue;
    }
    if (op.path) {
      setAttribute(next, op.path, op.value);
    } else if (typeof op.value === 'object' && op.value !== null && !Array.isArray(op.value)) {
      for (const [k, v] of Object.entries(op.value)) {
        if (k.toLowerCase() === 'name' && typeof v === 'object' && v !== null) {
          for (const [nk, nv] of Object.entries(v)) setAttribute(next, `name.${nk}`, nv);
        } else {
          setAttribute(next, k, v);
        }
      }
    } else {
      throw new ScimError(400, 'a value object or path is required', 'invalidSyntax');
    }
  }
  if (next.nameTouched) {
    next.displayName =
      [next.givenName, next.familyName].filter(Boolean).join(' ') || next.displayName;
  }
  return next;
};

export type GroupPatch = {
  displayName?: string;
  addMembers: string[];
  removeMembers: string[];
  /** Replace the whole member list. */
  replaceMembers: string[] | null;
};

const memberIds = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : [value];
  return list.map((m) => {
    const id = typeof m === 'object' && m !== null ? (m as { value?: unknown }).value : undefined;
    if (typeof id !== 'string' || !id) throw new ScimError(400, 'invalid member', 'invalidValue');
    return id;
  });
};

const MEMBER_FILTER = /^members\[value\s+eq\s+"([^"]+)"\]$/i;

/** Parses Group PATCH operations for the forms Okta and Entra send. */
export const parseGroupPatch = (ops: readonly PatchOperation[]): GroupPatch => {
  const patch: GroupPatch = { addMembers: [], removeMembers: [], replaceMembers: null };
  for (const op of ops) {
    const path = op.path?.trim();
    const filtered = path ? MEMBER_FILTER.exec(path) : null;
    if (filtered?.[1]) {
      if (op.op === 'remove') patch.removeMembers.push(filtered[1]);
      else throw new ScimError(400, 'filtered member paths only support remove', 'invalidPath');
    } else if (path?.toLowerCase() === 'members') {
      if (op.op === 'add') patch.addMembers.push(...memberIds(op.value));
      else if (op.op === 'remove') {
        if (op.value === undefined) patch.replaceMembers = [];
        else patch.removeMembers.push(...memberIds(op.value));
      } else patch.replaceMembers = memberIds(op.value);
    } else if (path?.toLowerCase() === 'displayname' && op.op !== 'remove') {
      patch.displayName = asString(op.value, 'displayName').trim();
    } else if (
      !path &&
      typeof op.value === 'object' &&
      op.value !== null &&
      !Array.isArray(op.value)
    ) {
      const obj = op.value as Record<string, unknown>;
      if (typeof obj.displayName === 'string') patch.displayName = obj.displayName.trim();
      if ('members' in obj) {
        if (op.op === 'add') patch.addMembers.push(...memberIds(obj.members));
        else patch.replaceMembers = memberIds(obj.members);
      }
    } else if (path) {
      throw new ScimError(400, `unsupported path ${path}`, 'invalidPath');
    }
  }
  return patch;
};
