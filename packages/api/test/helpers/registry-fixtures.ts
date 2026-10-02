import { parseRegistryEntry, type RegistryServerRow } from '@bastion-mcp/registry';

const row = (sourceId: string, entry: unknown): RegistryServerRow => {
  const e = parseRegistryEntry(entry);
  return {
    sourceId,
    name: e.name,
    version: e.version,
    serverJson: e.serverJson,
    status: e.status,
    publishedAt: e.publishedAt,
    isLatest: e.isLatest,
    meta: e.meta,
    searchDocument: `${e.name} ${e.serverJson.description}`.toLowerCase(),
  };
};

/** A remote server, an npm stdio server and a deleted one, as the mirror stores them (11.6). */
export const registryServerRows = (sourceId = 'src-official'): RegistryServerRow[] => [
  row(sourceId, {
    server: {
      name: 'io.github.acme/remote-docs',
      title: 'Acme Docs',
      description: 'Search the Acme docs',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/mcp' }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
  }),
  row(sourceId, {
    server: {
      name: 'io.github.acme/npm-tool',
      description: 'A local tool run with npx',
      version: '2.1.0',
      packages: [
        {
          registryType: 'npm',
          identifier: '@acme/mcp-tool',
          version: '2.1.0',
          transport: { type: 'stdio' },
          environmentVariables: [{ name: 'ACME_TOKEN', isSecret: true, isRequired: true }],
        },
      ],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
  }),
  row(sourceId, {
    server: {
      name: 'io.github.acme/gone',
      description: 'Removed server',
      version: '0.1.0',
      remotes: [{ type: 'streamable-http', url: 'https://gone.acme.example/mcp' }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', isLatest: true } },
  }),
];
