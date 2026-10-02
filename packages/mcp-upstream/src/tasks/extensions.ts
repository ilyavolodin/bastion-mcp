/**
 * Extension negotiation (6.8): Tasks, MCP Apps and Skills are known extensions; unknown extensions are declared
 * and forwarded verbatim only on single-installation endpoints. Admins allow or block identifiers per catalog entry.
 */

export const KNOWN_EXTENSIONS = [
  'io.modelcontextprotocol/tasks',
  'io.modelcontextprotocol/ui',
  'io.modelcontextprotocol/skills',
] as const;
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';

export type ExtensionPolicy = {
  allow?: readonly string[] | undefined;
  block?: readonly string[] | undefined;
};

const isKnown = (id: string): boolean => (KNOWN_EXTENSIONS as readonly string[]).includes(id);

/** Whether one extension identifier may be declared to (and used with) this installation. */
export const extensionAllowed = (
  id: string,
  policy: ExtensionPolicy,
  options: { singleInstallationEndpoint: boolean },
): boolean => {
  if (policy.block?.includes(id)) return false;
  if (policy.allow && policy.allow.length > 0 && !policy.allow.includes(id)) return false;
  if (!isKnown(id) && !options.singleInstallationEndpoint) return false;
  return true;
};

/** The downstream request's `extensions` capability map reduced to what this installation may see (6.8). */
export const filterExtensions = (
  declared: Record<string, unknown> | undefined,
  policy: ExtensionPolicy,
  options: { singleInstallationEndpoint: boolean },
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(declared ?? {})) {
    if (extensionAllowed(id, policy, options)) out[id] = value;
  }
  return out;
};
