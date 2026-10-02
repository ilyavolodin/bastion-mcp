/**
 * Client configuration generators for `GET /endpoints/{id}/client-config` (11.4, 17.2). Pure functions:
 * they take the endpoint address and return what a user pastes into their MCP client.
 */

export const CLIENT_KINDS = ['claude-desktop', 'claude-code', 'cursor', 'vscode'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** `oauth`: the client signs in through the browser (default). `pat`: a personal access token header. */
export type ClientAuth = 'oauth' | 'pat';

export type EndpointAddress = {
  /** `https://<host>` without a trailing slash. */
  baseUrl: string;
  /** `null` is the default endpoint `/mcp`. */
  slug: string | null;
  kind?: 'named' | 'installation' | 'catalog';
};

export type ClientConfig = {
  client: ClientKind;
  /** The streamable-HTTP URL of the endpoint (7.1). */
  url: string;
  /** Server name used as the key in the client's configuration. */
  name: string;
  auth: ClientAuth;
  /** File the JSON goes into, when the client has one. */
  file?: string;
  config?: Record<string, unknown>;
  /** Shell command, when the client has one. */
  command?: string;
  instructions: string[];
};

const SEGMENT = { named: 'e', installation: 'i', catalog: 'c' } as const;

export const endpointUrl = (address: EndpointAddress): string => {
  const base = address.baseUrl.replace(/\/+$/, '');
  if (address.slug === null) return `${base}/mcp`;
  return `${base}/mcp/${SEGMENT[address.kind ?? 'named']}/${address.slug}`;
};

/** A key that is safe in JSON configuration files and shell commands. */
export const serverName = (address: EndpointAddress): string =>
  `bastion-${address.slug ?? 'default'}`.replace(/[^A-Za-z0-9_-]/g, '-');

const PAT_PLACEHOLDER = '<your Bastion personal access token>';

export const clientConfigFor = (
  client: ClientKind,
  address: EndpointAddress,
  auth: ClientAuth = 'oauth',
): ClientConfig => {
  const url = endpointUrl(address);
  const name = serverName(address);
  const base = { client, url, name, auth } as const;
  switch (client) {
    case 'claude-desktop': {
      const args = ['-y', 'mcp-remote', url];
      if (auth === 'pat') args.push('--header', 'Authorization:${BASTION_AUTH}');
      return {
        ...base,
        file: 'claude_desktop_config.json',
        config: {
          mcpServers: {
            [name]: {
              command: 'npx',
              args,
              ...(auth === 'pat' ? { env: { BASTION_AUTH: `Bearer ${PAT_PLACEHOLDER}` } } : {}),
            },
          },
        },
        instructions: [
          'Preferred: Settings > Connectors > Add custom connector, and paste the URL; Claude opens the Bastion sign-in.',
          'Alternative for the local config file: add the block to claude_desktop_config.json and restart Claude Desktop.',
          'The mcp-remote bridge needs Node.js 20 or later.',
        ],
      };
    }
    case 'claude-code': {
      const header = auth === 'pat' ? ` --header "Authorization: Bearer ${PAT_PLACEHOLDER}"` : '';
      return {
        ...base,
        file: '.mcp.json',
        command: `claude mcp add --transport http ${name} ${url}${header}`,
        config: {
          mcpServers: {
            [name]: {
              type: 'http',
              url,
              ...(auth === 'pat' ? { headers: { Authorization: 'Bearer ${BASTION_TOKEN}' } } : {}),
            },
          },
        },
        instructions:
          auth === 'oauth'
            ? ['Run the command, then use /mcp inside Claude Code and choose Authenticate.']
            : ['Run the command, or commit .mcp.json and export BASTION_TOKEN in your shell.'],
      };
    }
    case 'cursor':
      return {
        ...base,
        file: '.cursor/mcp.json',
        config: {
          mcpServers: {
            [name]: {
              url,
              ...(auth === 'pat'
                ? { headers: { Authorization: 'Bearer ${env:BASTION_TOKEN}' } }
                : {}),
            },
          },
        },
        instructions: [
          'Add the block to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global).',
          auth === 'oauth'
            ? 'Cursor opens the Bastion sign-in the first time the server is used.'
            : 'Export BASTION_TOKEN with your personal access token before starting Cursor.',
        ],
      };
    case 'vscode':
      return {
        ...base,
        file: '.vscode/mcp.json',
        config: {
          servers: {
            [name]: {
              type: 'http',
              url,
              ...(auth === 'pat'
                ? { headers: { Authorization: 'Bearer ${input:bastion-token}' } }
                : {}),
            },
          },
          ...(auth === 'pat'
            ? {
                inputs: [
                  {
                    type: 'promptString',
                    id: 'bastion-token',
                    description: 'Bastion personal access token',
                    password: true,
                  },
                ],
              }
            : {}),
        },
        instructions: [
          'Add the block to .vscode/mcp.json, or run "MCP: Add Server" and choose HTTP.',
          auth === 'oauth'
            ? 'VS Code opens the Bastion sign-in when you start the server.'
            : 'VS Code prompts for the token once and stores it securely.',
        ],
      };
  }
};
