import type { Schema } from '@cedar-policy/cedar-wasm/nodejs';
import schemaJson from '../schema.cedarschema.json' with { type: 'json' };

/** Cedar namespace of every Bastion entity and action (10.2). */
export const NAMESPACE = 'Bastion';

/** Invocation actions: depend on request context, evaluated per request (10.4). */
export const INVOCATION_ACTIONS = [
  'useInstallation',
  'callTool',
  'getPrompt',
  'readResource',
  'subscribeResource',
  'complete',
] as const;

/** Visibility actions: evaluated at endpoint compilation and cached (10.4). */
export const VISIBILITY_ACTIONS = ['seeTool', 'seePrompt', 'seeResource'] as const;

export const MCP_ACTIONS = [...INVOCATION_ACTIONS, ...VISIBILITY_ACTIONS] as const;

/** Management actions: every control-plane route declares one (17.1, 17.2). */
export const MANAGEMENT_ACTIONS = [
  'seeCatalog',
  'catalog.create',
  'catalog.update',
  'catalog.publish',
  'catalog.delete',
  'marketplace.manage',
  'plugin.approveExecutable',
  'installation.manage',
  'override.edit',
  'policy.edit',
  'guard.edit',
  'user.manage',
  'team.manage',
  'registry.install',
  'logs.view',
  'audit.view',
  'settings.edit',
  'secrets.manage',
] as const;

export type McpAction = (typeof MCP_ACTIONS)[number];
export type InvocationAction = (typeof INVOCATION_ACTIONS)[number];
export type VisibilityAction = (typeof VISIBILITY_ACTIONS)[number];
export type ManagementAction = (typeof MANAGEMENT_ACTIONS)[number];
export type PolicyAction = McpAction | ManagementAction;

export const ALL_ACTIONS: readonly PolicyAction[] = [...MCP_ACTIONS, ...MANAGEMENT_ACTIONS];

const MCP_ACTION_SET: ReadonlySet<string> = new Set(MCP_ACTIONS);
export const isMcpAction = (action: PolicyAction): action is McpAction =>
  MCP_ACTION_SET.has(action);

/** The Cedar schema in JSON format (10.2); validation always uses strict mode. */
export const loadSchema = (): Schema => structuredClone(schemaJson) as unknown as Schema;
