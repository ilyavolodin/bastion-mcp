/** The connection snippets of 11.4: pure functions of the endpoint URL, its name and the sign-in method. */
import type { Res } from '@/api/schema';

type ClientKind = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode';
const CLIENT_KINDS: readonly string[] = ['claude-desktop', 'claude-code', 'cursor', 'vscode'];
type ClientConfig = Res<'get', '/client-config'>;

const PAT = '<your Bastion personal access token>';

export const clientConfig = (
  client: ClientKind,
  url: string,
  name: string,
  auth: 'oauth' | 'pat',
): ClientConfig => {
  const base = { client, url, name, auth } as const;
  switch (client) {
    case 'claude-desktop':
      return {
        ...base,
        file: 'claude_desktop_config.json',
        config: {
          mcpServers: {
            [name]: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                url,
                ...(auth === 'pat'
                  ? [
                      '--header', // biome-ignore lint/suspicious/noTemplateCurlyInString: the client expands ${BASTION_AUTH} itself
                      'Authorization:${BASTION_AUTH}',
                    ]
                  : []),
              ],
              ...(auth === 'pat' ? { env: { BASTION_AUTH: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: [
          'Preferred: Settings > Connectors > Add custom connector, and paste the URL; Claude opens the Bastion sign-in.',
          'Alternative for the local config file: add the block to claude_desktop_config.json and restart Claude Desktop.',
          'The mcp-remote bridge needs Node.js 20 or later.',
        ],
      };
    case 'claude-code':
      return {
        ...base,
        command: `claude mcp add --transport http ${name} ${url}${auth === 'pat' ? ` --header "Authorization: Bearer ${PAT}"` : ''}`,
        instructions: [
          'Run the command once in a terminal.',
          'Then run /mcp in Claude Code and sign in.',
        ],
      };
    case 'cursor':
      return {
        ...base,
        file: '~/.cursor/mcp.json',
        config: {
          mcpServers: {
            [name]: {
              url,
              ...(auth === 'pat' ? { headers: { Authorization: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: ['Save the block as ~/.cursor/mcp.json and reload Cursor.'],
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
              ...(auth === 'pat' ? { headers: { Authorization: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: ['Save the block as .vscode/mcp.json in your workspace.'],
      };
  }
};

export const clientQuery = (url: URL) => {
  const client = url.searchParams.get('client') ?? '';
  const auth = url.searchParams.get('auth') ?? 'oauth';
  if (!CLIENT_KINDS.includes(client) || !['oauth', 'pat'].includes(auth)) {
    return null;
  }
  return { client: client as ClientKind, auth: auth as 'oauth' | 'pat' };
};
