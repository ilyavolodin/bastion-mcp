/** Support for the UI (7.1, 7.3): tool-count warning and collision warnings. */
import type { Collision, EffectiveEndpoint } from './types';

export const DEFAULT_TOOL_WARN_THRESHOLD = 40;

export type ToolCountWarning = {
  count: number;
  threshold: number;
  exceeded: boolean;
  /** Installations by tool count, largest first: the candidates to split or to hide tools from. */
  byInstallation: Array<{ installationId: string; displayName: string; toolCount: number }>;
  actions: Array<'split_endpoint' | 'hide_tools'>;
};

/** Warns when an endpoint passes `endpoints.toolWarnThreshold` (default 40) (7.1). */
export const toolCountWarning = (
  endpoint: Pick<EffectiveEndpoint, 'tools' | 'installations'>,
  threshold: number = DEFAULT_TOOL_WARN_THRESHOLD,
): ToolCountWarning => {
  const count = endpoint.tools.length;
  const exceeded = count > threshold;
  return {
    count,
    threshold,
    exceeded,
    byInstallation: endpoint.installations
      .filter((i) => i.toolCount > 0)
      .map((i) => ({ installationId: i.id, displayName: i.displayName, toolCount: i.toolCount }))
      .sort((a, b) => b.toolCount - a.toolCount || (a.installationId < b.installationId ? -1 : 1)),
    actions: exceeded ? ['split_endpoint', 'hide_tools'] : [],
  };
};

/** Collisions per installation: shown on every installation involved (7.3). */
export const collisionWarnings = (
  endpoint: Pick<EffectiveEndpoint, 'collisions'>,
): Map<string, Collision[]> => {
  const out = new Map<string, Collision[]>();
  for (const c of endpoint.collisions) {
    for (const id of c.installationIds) out.set(id, [...(out.get(id) ?? []), c]);
  }
  return out;
};
