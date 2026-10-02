/**
 * VENDORED, RECONSTRUCTED SCHEMAS. These are local stand-ins for
 *   https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
 *   https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
 * written from the field list in docs/tdd.md 25.2 and 25.4 and the public Agent Plugins format. They
 * validate offline (25.3) but were NOT copied from the published documents. Before relying on them,
 * diff them against the real schemas and replace these objects with the published ones.
 * Property names Bastion emits (`displayName`, `skills`, `mcpServers`, `apps`, `hooks`,
 * `extensions`) are the ones to compare first.
 */
export const VENDORED_SCHEMA_NOTICE =
  'reconstructed locally; diff against agent-plugins.org 1.0.0 before trusting';

const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$';

export const AGENT_PLUGIN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  title: 'Agent Plugin manifest (vendored reconstruction)',
  type: 'object',
  required: ['name', 'version', 'description'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    name: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 },
    version: { type: 'string', pattern: SEMVER_PATTERN },
    description: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    skills: { type: 'string', pattern: '^\\./' },
    mcpServers: { type: 'string', pattern: '^\\./' },
    apps: { type: 'string', pattern: '^\\./' },
    hooks: { type: 'string', pattern: '^\\./' },
    extensions: { type: 'object', additionalProperties: { type: 'object' } },
  },
} as const;

export const AGENT_MCP_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  title: 'Agent Plugin MCP servers (vendored reconstruction)',
  type: 'object',
  required: ['mcpServers'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    mcpServers: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'url'],
            additionalProperties: false,
            properties: {
              type: { enum: ['streamable-http', 'sse'] },
              url: { type: 'string', pattern: '^https?://' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
          {
            type: 'object',
            required: ['type', 'command'],
            additionalProperties: false,
            properties: {
              type: { const: 'stdio' },
              command: { type: 'string', minLength: 1 },
              args: { type: 'array', items: { type: 'string' } },
              env: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        ],
      },
    },
  },
} as const;
