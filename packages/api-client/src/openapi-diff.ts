/**
 * A small OpenAPI breaking-change checker (CI): compares two documents produced by the API generator and
 * reports changes that can break existing clients. Not a general-purpose differ: it understands the subset
 * of OpenAPI 3.1 and JSON Schema that the zod generator emits.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export type Change = { kind: 'breaking' | 'compatible'; where: string; message: string };

export type DiffResult = {
  breaking: Change[];
  compatible: Change[];
  versionBefore: string;
  versionAfter: string;
  /** True when breaking changes exist and the major version did not increase. */
  needsVersionBump: boolean;
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

type Ctx = { before: Obj; after: Obj; out: Change[] };

const resolveRef = (root: Obj, node: Json | undefined): Obj => {
  let current = obj(node);
  for (let hops = 0; hops < 20; hops += 1) {
    const ref = str(current.$ref);
    if (!ref?.startsWith('#/')) return current;
    let target: Json | undefined = root;
    for (const part of ref.slice(2).split('/'))
      target = obj(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    current = obj(target);
  }
  return current;
};

const typesOf = (schema: Obj): string[] => {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
};

const variants = (schema: Obj): Obj[] =>
  [...arr(schema.anyOf), ...arr(schema.oneOf)].map((v) => obj(v));

type Direction = 'request' | 'response';

/**
 * Request side: clients send data, so tightening (new required property, narrower type or enum) breaks them.
 * Response side: clients read data, so loosening (removed property, wider type) breaks them.
 */
const compareSchema = (
  ctx: Ctx,
  before: Json | undefined,
  after: Json | undefined,
  direction: Direction,
  where: string,
  seen: Set<string> = new Set(),
): void => {
  const b = resolveRef(ctx.before, before);
  const a = resolveRef(ctx.after, after);
  const key = `${where}|${str(obj(before).$ref) ?? ''}|${str(obj(after).$ref) ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  const push = (kind: Change['kind'], message: string): void => {
    ctx.out.push({ kind, where, message });
  };

  const bTypes = typesOf(b);
  const aTypes = typesOf(a);
  if (bTypes.length > 0 && aTypes.length > 0) {
    const removed = bTypes.filter((t) => !aTypes.includes(t));
    const added = aTypes.filter((t) => !bTypes.includes(t));
    if (direction === 'request' && removed.length > 0) {
      push('breaking', `request type no longer accepts ${removed.join(', ')}`);
    }
    if (direction === 'response' && added.length > 0) {
      push('breaking', `response may now be ${added.join(', ')}`);
    }
  }

  const bEnum = arr(b.enum);
  const aEnum = arr(a.enum);
  if (bEnum.length > 0 && aEnum.length > 0) {
    const removed = bEnum.filter((v) => !aEnum.includes(v));
    const added = aEnum.filter((v) => !bEnum.includes(v));
    if (direction === 'request' && removed.length > 0) {
      push('breaking', `request no longer accepts ${removed.map(String).join(', ')}`);
    }
    if (direction === 'response' && added.length > 0) {
      push('breaking', `response may now contain ${added.map(String).join(', ')}`);
    }
  } else if (bEnum.length === 0 && aEnum.length > 0 && direction === 'request') {
    push('breaking', 'request values are now restricted to an enum');
  }

  const bProps = obj(b.properties);
  const aProps = obj(a.properties);
  const bRequired = arr(b.required).map(String);
  const aRequired = arr(a.required).map(String);
  for (const name of Object.keys(bProps)) {
    if (!(name in aProps)) {
      if (direction === 'response') push('breaking', `response property ${name} was removed`);
      continue;
    }
    compareSchema(ctx, bProps[name], aProps[name], direction, `${where}.${name}`, seen);
  }
  for (const name of Object.keys(aProps)) {
    if (name in bProps) continue;
    if (direction === 'request' && aRequired.includes(name)) {
      push('breaking', `request property ${name} is new and required`);
    } else {
      push('compatible', `property ${name} was added`);
    }
  }
  for (const name of aRequired) {
    if (direction === 'request' && !bRequired.includes(name) && name in bProps) {
      push('breaking', `request property ${name} became required`);
    }
  }
  for (const name of bRequired) {
    if (direction === 'response' && !aRequired.includes(name) && name in aProps) {
      push('breaking', `response property ${name} is no longer always present`);
    }
  }

  if (b.items !== undefined && a.items !== undefined) {
    compareSchema(ctx, b.items, a.items, direction, `${where}[]`, seen);
  }

  const bVariants = variants(b);
  const aVariants = variants(a);
  if (bVariants.length > 0 && aVariants.length > 0) {
    if (direction === 'request' && aVariants.length < bVariants.length) {
      push('breaking', 'request no longer accepts every previous alternative');
    }
    if (direction === 'response' && aVariants.length > bVariants.length) {
      push('breaking', 'response has new alternatives');
    }
    const shared = Math.min(bVariants.length, aVariants.length);
    for (let i = 0; i < shared; i += 1) {
      compareSchema(ctx, bVariants[i], aVariants[i], direction, `${where}|${i}`, seen);
    }
  }
};

const paramKey = (p: Obj): string => `${str(p.in) ?? ''}:${str(p.name) ?? ''}`;

const jsonSchemaOf = (content: Json | undefined): Json | undefined => {
  const c = obj(content);
  const media = obj(c['application/json'] ?? Object.values(c)[0]);
  return media.schema;
};

const compareOperation = (ctx: Ctx, where: string, before: Obj, after: Obj): void => {
  const push = (kind: Change['kind'], message: string): void => {
    ctx.out.push({ kind, where, message });
  };
  const bParams = new Map(
    arr(before.parameters).map((p) => [
      paramKey(resolveRef(ctx.before, p)),
      resolveRef(ctx.before, p),
    ]),
  );
  const aParams = new Map(
    arr(after.parameters).map((p) => [
      paramKey(resolveRef(ctx.after, p)),
      resolveRef(ctx.after, p),
    ]),
  );
  for (const [key, param] of aParams) {
    const old = bParams.get(key);
    if (!old) {
      if (param.required === true) push('breaking', `new required parameter ${key}`);
      else push('compatible', `new optional parameter ${key}`);
      continue;
    }
    if (old.required !== true && param.required === true)
      push('breaking', `parameter ${key} became required`);
    compareSchema(ctx, old.schema, param.schema, 'request', `${where} param ${key}`);
  }
  for (const key of bParams.keys()) {
    if (!aParams.has(key)) push('breaking', `parameter ${key} was removed`);
  }

  const bBody = resolveRef(ctx.before, before.requestBody);
  const aBody = resolveRef(ctx.after, after.requestBody);
  if (Object.keys(aBody).length > 0 && Object.keys(bBody).length === 0) {
    push(aBody.required === true ? 'breaking' : 'compatible', 'a request body was added');
  } else if (Object.keys(bBody).length > 0 && Object.keys(aBody).length === 0) {
    push('breaking', 'the request body was removed');
  } else if (Object.keys(bBody).length > 0) {
    if (bBody.required !== true && aBody.required === true)
      push('breaking', 'the request body became required');
    compareSchema(
      ctx,
      jsonSchemaOf(bBody.content),
      jsonSchemaOf(aBody.content),
      'request',
      `${where} body`,
    );
  }

  const bResponses = obj(before.responses);
  const aResponses = obj(after.responses);
  for (const status of Object.keys(bResponses)) {
    const success = /^2\d\d$/.test(status);
    const next = aResponses[status];
    if (next === undefined) {
      push(success ? 'breaking' : 'compatible', `response ${status} was removed`);
      continue;
    }
    if (!success) continue;
    const bRes = resolveRef(ctx.before, bResponses[status]);
    const aRes = resolveRef(ctx.after, next);
    compareSchema(
      ctx,
      jsonSchemaOf(bRes.content),
      jsonSchemaOf(aRes.content),
      'response',
      `${where} ${status}`,
    );
  }
  for (const status of Object.keys(aResponses)) {
    if (!(status in bResponses)) push('compatible', `response ${status} was added`);
  }
};

const major = (version: string): number => Number.parseInt(version.split('.')[0] ?? '0', 10) || 0;

/** Compares two OpenAPI documents (`before` is the committed snapshot). */
export const diffOpenApi = (before: unknown, after: unknown): DiffResult => {
  const b = obj(before as Json);
  const a = obj(after as Json);
  const ctx: Ctx = { before: b, after: a, out: [] };
  const bPaths = obj(b.paths);
  const aPaths = obj(a.paths);
  for (const [path, item] of Object.entries(bPaths)) {
    const next = obj(aPaths[path]);
    for (const method of METHODS) {
      const op = obj(item)[method];
      if (op === undefined) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const nextOp = next[method];
      if (nextOp === undefined) {
        ctx.out.push({ kind: 'breaking', where, message: 'operation was removed' });
        continue;
      }
      compareOperation(ctx, where, obj(op), obj(nextOp));
    }
  }
  for (const [path, item] of Object.entries(aPaths)) {
    for (const method of METHODS) {
      if (obj(item)[method] !== undefined && obj(obj(bPaths[path]))[method] === undefined) {
        ctx.out.push({
          kind: 'compatible',
          where: `${method.toUpperCase()} ${path}`,
          message: 'operation was added',
        });
      }
    }
  }
  const bSchemes = Object.keys(obj(obj(b.components).securitySchemes));
  const aSchemes = Object.keys(obj(obj(a.components).securitySchemes));
  for (const name of bSchemes) {
    if (!aSchemes.includes(name)) {
      ctx.out.push({
        kind: 'breaking',
        where: 'security',
        message: `security scheme ${name} was removed`,
      });
    }
  }
  const versionBefore = str(obj(b.info).version) ?? '0.0.0';
  const versionAfter = str(obj(a.info).version) ?? '0.0.0';
  const breaking = ctx.out.filter((c) => c.kind === 'breaking');
  return {
    breaking,
    compatible: ctx.out.filter((c) => c.kind === 'compatible'),
    versionBefore,
    versionAfter,
    needsVersionBump: breaking.length > 0 && major(versionAfter) <= major(versionBefore),
  };
};
