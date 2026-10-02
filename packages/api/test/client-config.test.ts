import { describe, expect, it } from 'vitest';
import {
  CLIENT_KINDS,
  clientConfigFor,
  endpointUrl,
  serverName,
} from '../src/services/client-config';

const base = { baseUrl: 'https://bastion.example.com/', slug: 'work' };

describe('11.4 client configuration generators', () => {
  it('7.1 builds endpoint URLs for the default, named, installation and catalog endpoints', () => {
    expect(endpointUrl({ baseUrl: 'https://h', slug: null })).toBe('https://h/mcp');
    expect(endpointUrl({ baseUrl: 'https://h/', slug: 'work' })).toBe('https://h/mcp/e/work');
    expect(endpointUrl({ baseUrl: 'https://h', slug: 'gh', kind: 'installation' })).toBe(
      'https://h/mcp/i/gh',
    );
    expect(endpointUrl({ baseUrl: 'https://h', slug: 'gh', kind: 'catalog' })).toBe(
      'https://h/mcp/c/gh',
    );
  });

  it('11.4 derives a shell-safe server name', () => {
    expect(serverName({ baseUrl: 'https://h', slug: 'a b' })).toBe('bastion-a-b');
    expect(serverName({ baseUrl: 'https://h', slug: null })).toBe('bastion-default');
  });

  it('11.4 claude-code gives the `claude mcp add --transport http` command and .mcp.json', () => {
    const c = clientConfigFor('claude-code', base);
    expect(c.command).toBe(
      'claude mcp add --transport http bastion-work https://bastion.example.com/mcp/e/work',
    );
    expect(c.config).toEqual({
      mcpServers: {
        'bastion-work': { type: 'http', url: 'https://bastion.example.com/mcp/e/work' },
      },
    });
  });

  it('11.4 claude-code with a PAT adds the Authorization header', () => {
    const c = clientConfigFor('claude-code', base, 'pat');
    expect(c.command).toContain('--header "Authorization: Bearer');
    expect(JSON.stringify(c.config)).toContain('${BASTION_TOKEN}');
  });

  it('11.4 claude-desktop uses mcp-remote and mentions custom connectors', () => {
    const c = clientConfigFor('claude-desktop', base);
    expect(c.file).toBe('claude_desktop_config.json');
    expect(c.config).toEqual({
      mcpServers: {
        'bastion-work': {
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://bastion.example.com/mcp/e/work'],
        },
      },
    });
    expect(c.instructions.join(' ')).toContain('custom connector');
    const pat = clientConfigFor('claude-desktop', base, 'pat');
    expect(JSON.stringify(pat.config)).toContain('BASTION_AUTH');
  });

  it('11.4 cursor writes .cursor/mcp.json with a url entry', () => {
    const c = clientConfigFor('cursor', base);
    expect(c.file).toBe('.cursor/mcp.json');
    expect(c.config).toEqual({
      mcpServers: { 'bastion-work': { url: 'https://bastion.example.com/mcp/e/work' } },
    });
    expect(JSON.stringify(clientConfigFor('cursor', base, 'pat').config)).toContain(
      'env:BASTION_TOKEN',
    );
  });

  it('11.4 vscode writes .vscode/mcp.json with type http and a password input for PATs', () => {
    const c = clientConfigFor('vscode', base);
    expect(c.config).toEqual({
      servers: { 'bastion-work': { type: 'http', url: 'https://bastion.example.com/mcp/e/work' } },
    });
    const pat = clientConfigFor('vscode', base, 'pat');
    expect(JSON.stringify(pat.config)).toContain('"password":true');
  });

  it('11.4 every client kind is covered and never embeds a real secret', () => {
    for (const kind of CLIENT_KINDS) {
      const c = clientConfigFor(kind, base, 'pat');
      expect(c.client).toBe(kind);
      expect(JSON.stringify(c)).not.toMatch(/bst_pat_[A-Za-z0-9]{10,}/);
    }
  });
});
