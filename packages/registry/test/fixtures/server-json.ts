/** Realistic `server.json` documents (schema 2025-12-11) used as golden inputs. */

const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

export const npmStdioSecrets = {
  $schema: SCHEMA,
  name: 'io.github.acme/github-tools',
  title: 'Acme GitHub Tools',
  description: 'Issues, pull requests and code search for GitHub.',
  version: '2.4.1',
  repository: { url: 'https://github.com/acme/github-tools', source: 'github' },
  packages: [
    {
      registryType: 'npm',
      identifier: '@acme/github-tools-mcp',
      version: '2.4.1',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      packageArguments: [
        {
          type: 'named',
          name: '--org',
          valueHint: 'org',
          description: 'GitHub organization',
          isRequired: true,
        },
        { type: 'named', name: '--readonly', isRequired: true },
        { type: 'positional', valueHint: 'toolset', default: 'all' },
      ],
      environmentVariables: [
        {
          name: 'GITHUB_TOKEN',
          description: 'Personal access token',
          isRequired: true,
          isSecret: true,
        },
        {
          name: 'GITHUB_API_URL',
          description: 'API base URL',
          default: 'https://api.github.com',
          choices: ['https://api.github.com', 'https://github.example.com/api/v3'],
        },
        { name: 'LOG_LEVEL', value: 'info' },
      ],
    },
  ],
};

export const pypiStdio = {
  $schema: SCHEMA,
  name: 'io.github.acme/postgres-inspector',
  description: 'Read-only schema and query inspection for PostgreSQL.',
  version: '0.9.3',
  packages: [
    {
      registryType: 'pypi',
      identifier: 'postgres-inspector-mcp',
      version: '0.9.3',
      runtimeHint: 'uvx',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'named', name: '--python', value: '3.12' }],
      packageArguments: [
        {
          type: 'positional',
          valueHint: 'dsn',
          isRequired: true,
          description: 'Connection string',
        },
      ],
      environmentVariables: [{ name: 'PGPASSWORD', isSecret: true, isRequired: true }],
    },
  ],
};

export const remoteWithHeaders = {
  $schema: SCHEMA,
  name: 'com.atlassian/jira',
  title: 'Jira',
  description: 'Search and update Jira issues.',
  version: '1.2.0',
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://mcp.atlassian.example/v1/mcp',
      headers: [
        {
          name: 'Authorization',
          description: 'API token',
          isRequired: true,
          isSecret: true,
          value: 'Bearer {api_token}',
          variables: { api_token: { isSecret: true, isRequired: true } },
        },
        { name: 'X-Client', value: 'bastion' },
      ],
    },
  ],
};

export const remoteWithUrlVariables = {
  $schema: SCHEMA,
  name: 'io.github.example/tenant-docs',
  description: 'Documentation search for a tenant.',
  version: '3.0.0',
  remotes: [
    {
      type: 'sse',
      url: 'https://{tenant}.docs.example.com/{region}/mcp',
      variables: {
        tenant: { description: 'Tenant subdomain', isRequired: true },
        region: { description: 'Data region', default: 'eu', choices: ['eu', 'us'] },
      },
    },
  ],
};

export const ociOnly = {
  $schema: SCHEMA,
  name: 'io.github.acme/container-tools',
  description: 'Runs as a container.',
  version: '1.0.0',
  packages: [
    {
      registryType: 'oci',
      identifier: 'ghcr.io/acme/container-tools:1.0.0',
      version: '1.0.0',
      transport: { type: 'stdio' },
    },
  ],
};

export const nugetAndMcpb = {
  $schema: SCHEMA,
  name: 'com.example/dotnet-tools',
  description: 'NuGet and MCPB builds only.',
  version: '5.1.0',
  packages: [
    {
      registryType: 'nuget',
      identifier: 'Example.Mcp.Server',
      version: '5.1.0',
      transport: { type: 'stdio' },
    },
    {
      registryType: 'mcpb',
      identifier: 'https://example.com/tools.mcpb',
      version: '5.1.0',
      fileSha256: 'a'.repeat(64),
      transport: { type: 'stdio' },
    },
  ],
};

export const bothRemoteAndPackage = {
  $schema: SCHEMA,
  name: 'io.github.acme/search',
  description: 'Web search, hosted or local.',
  version: '1.5.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'acme-search-mcp',
      version: '1.5.0',
      transport: { type: 'stdio' },
      environmentVariables: [{ name: 'SEARCH_API_KEY', isSecret: true, isRequired: true }],
    },
  ],
  remotes: [{ type: 'streamable-http', url: 'https://search.acme.example/mcp' }],
};

export const deprecatedServer = {
  $schema: SCHEMA,
  name: 'io.github.legacy/old-notes',
  description: 'Superseded by io.github.acme/notes.',
  version: '0.3.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'old-notes-mcp',
      version: '0.3.0',
      transport: { type: 'stdio' },
    },
  ],
};

export const deletedServer = {
  $schema: SCHEMA,
  name: 'io.github.shady/typosquat',
  description: 'Removed by the registry.',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'typosquat-mcp',
      version: '1.0.0',
      transport: { type: 'stdio' },
    },
  ],
};

export const rangeVersion = {
  $schema: SCHEMA,
  name: 'io.github.acme/ranged',
  description: 'Declares a range instead of an exact version.',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'ranged-mcp',
      version: '^1.0.0',
      transport: { type: 'stdio' },
    },
  ],
};

export const packageOnlyStreamableTransport = {
  $schema: SCHEMA,
  name: 'io.github.acme/http-package',
  description: 'An npm package that speaks streamable HTTP, not stdio.',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'http-pkg-mcp',
      version: '1.0.0',
      transport: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
    },
  ],
};

export const entryOf = (
  server: unknown,
  status: 'active' | 'deprecated' | 'deleted' = 'active',
  extra: { isLatest?: boolean; updatedAt?: string } = {},
) => ({
  server,
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status,
      publishedAt: '2025-12-20T10:00:00Z',
      updatedAt: extra.updatedAt ?? '2026-01-05T08:30:00Z',
      isLatest: extra.isLatest ?? true,
    },
  },
});
