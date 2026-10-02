import { parseRule, type Rule } from '@bastion-mcp/limits';
import { ApiError, NotFoundApiError } from '../errors';
import type { Row } from '../ports/store';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';

export const limitRules = new CrudService({
  collection: 'limit_rules',
  targetType: 'limit_rule',
  action: 'limit_rule',
  configTopic: 'limits',
});

/** Parses a stored or submitted rule; a bad one is a 422 with the zod issues. */
export const assertRule = (fields: Record<string, unknown>): Rule => {
  try {
    return parseRule({ id: 'candidate', ...fields });
  } catch (error) {
    const issues =
      typeof error === 'object' && error !== null && 'issues' in error
        ? (error.issues as Array<{ path: Array<string | number>; message: string }>)
        : [];
    throw new ApiError('invalid_rule', 'the limit rule is not valid', 422, {
      errors: issues.map((i) => ({ path: `/${i.path.join('/')}`, message: i.message })),
    });
  }
};

export const createLimitRule = (ctx: WriteCtx, body: Record<string, unknown>) => {
  assertRule(body);
  return limitRules.create(ctx, body);
};

export const updateLimitRule = async (
  ctx: WriteCtx,
  id: string,
  patch: Record<string, unknown>,
) => {
  const current = await ctx.tx.store.get('limit_rules', id);
  if (!current) throw new NotFoundApiError('limit_rule');
  const { id: _id, updatedAt: _u, createdAt: _c, ...fields } = current;
  assertRule({ ...fields, ...patch });
  return limitRules.update(ctx, id, patch);
};

const parsedRow = (row: Row): Rule => assertRule({ ...row, id: row.id });

/**
 * Current consumption of one rule (14.2). With `subjectId` it reads that counter; otherwise the rule's own
 * subjects: an explicit `subjectMatch` list, or `org` for org rules. Per-subject counters of `each` rules need
 * a `subjectId` (there is no counter index).
 */
export const ruleUsage = async (
  ctx: Pick<ReadCtx, 'deps'>,
  id: string,
  subjectId: string | undefined,
) => {
  const row = await limitRules.require(ctx, id);
  const rule = parsedRow(row);
  const subjects =
    subjectId !== undefined
      ? [subjectId]
      : Array.isArray(rule.subjectMatch)
        ? rule.subjectMatch
        : rule.subject === 'org'
          ? ['org']
          : [];
  const items = await Promise.all(subjects.map((s) => ctx.deps.limits.readUsage(rule, s)));
  return { items };
};
