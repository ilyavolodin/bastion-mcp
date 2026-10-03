/**
 * Value templates (8.1): a purpose-built resolver with no expression language.
 * References look like `{{namespace.NAME}}`.
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const REFERENCE = /\{\{([^{}]*)\}\}/g;
const USER_FIELDS = ['email', 'id', 'teams'] as const;
const FIXED_FIELDS = {
  oauth: ['accessToken'],
  sandbox: ['workspace'],
  user: USER_FIELDS,
} as const;
const OPEN_NAMESPACES = ['var', 'secret'] as const;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TemplateContext = {
  var?: Record<string, string>;
  secret?: Record<string, string>;
  oauth?: { accessToken?: string };
  user?: { email?: string; id?: string; teams?: string[] };
  sandbox?: { workspace?: string };
};

/** `{{secret.NAME}}` reference text. */
export const secretRef = (name: string): string => `{{secret.${name}}}`;

/** `{{var.NAME}}` reference text. */
export const varRef = (name: string): string => `{{var.${name}}}`;

const parseReference = (raw: string): { namespace: string; field: string } => {
  const ref = raw.trim();
  const dot = ref.indexOf('.');
  const namespace = dot < 0 ? ref : ref.slice(0, dot);
  const field = dot < 0 ? '' : ref.slice(dot + 1);
  const isOpen = (OPEN_NAMESPACES as readonly string[]).includes(namespace);
  const fixed = FIXED_FIELDS[namespace as keyof typeof FIXED_FIELDS] as
    | readonly string[]
    | undefined;
  if (!isOpen && !fixed)
    throw new TemplateError(`unknown template namespace "${namespace}" in {{${ref}}}`);
  if (isOpen && !NAME.test(field)) throw new TemplateError(`invalid reference {{${ref}}}`);
  if (fixed && !fixed.includes(field)) throw new TemplateError(`unknown reference {{${ref}}}`);
  return { namespace, field };
};

/** All references in order of first appearance, deduplicated, as `namespace.field`. */
export const extractReferences = (template: string): string[] => {
  const seen = new Set<string>();
  for (const match of template.matchAll(REFERENCE)) seen.add((match[1] as string).trim());
  return [...seen];
};

/** Throws when any reference in the template is unknown. Run when a catalog entry is saved. */
export const validateTemplate = (template: string): void => {
  for (const ref of extractReferences(template)) parseReference(ref);
};

const lookup = (ctx: TemplateContext, namespace: string, field: string): string | undefined => {
  switch (namespace) {
    case 'var':
      return ctx.var?.[field];
    case 'secret':
      return ctx.secret?.[field];
    case 'oauth':
      return ctx.oauth?.accessToken;
    case 'sandbox':
      return ctx.sandbox?.workspace;
    case 'user': {
      if (field === 'teams') return ctx.user?.teams?.join(',');
      return ctx.user?.[field as 'email' | 'id'];
    }
    default:
      return undefined;
  }
};

/** Resolves every reference; a missing value is an error naming the reference (never the value). */
export const resolveTemplate = (template: string, ctx: TemplateContext): string =>
  template.replace(REFERENCE, (_whole, raw: string) => {
    const { namespace, field } = parseReference(raw);
    const value = lookup(ctx, namespace, field);
    if (value === undefined) throw new TemplateError(`no value for {{${namespace}.${field}}}`);
    return value;
  });

/** Shared instances cannot hold per-user values (8.6). */
export const assertNoPerUserReferences = (templates: readonly string[]): void => {
  for (const template of templates) {
    for (const ref of extractReferences(template)) {
      const { namespace } = parseReference(ref);
      if (namespace === 'user' || namespace === 'oauth') {
        throw new TemplateError(`shared instances cannot use per-user reference {{${ref}}}`);
      }
    }
  }
};
