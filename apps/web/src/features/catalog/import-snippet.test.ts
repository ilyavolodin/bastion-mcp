import { describe, expect, it } from 'vitest';
import { importSnippet } from './import-snippet';

describe('importSnippet (11.3)', () => {
  it('reads an npx command: the package and its exact version', () => {
    expect(
      importSnippet(JSON.stringify({ command: 'npx', args: ['-y', '@acme/pg-mcp@3.2.0'] })),
    ).toEqual({
      runtime: 'npm',
      package: '@acme/pg-mcp',
      version: '3.2.0',
      command: 'npx',
      args: ['-y', '@acme/pg-mcp@3.2.0'],
      url: '',
    });
  });

  it('keeps the scope of a scoped package that has no version', () => {
    expect(importSnippet(JSON.stringify({ command: 'npx', args: ['@acme/pg-mcp'] }))).toMatchObject(
      {
        package: '@acme/pg-mcp',
        version: '',
      },
    );
  });

  it('maps uvx to Python', () => {
    expect(
      importSnippet(JSON.stringify({ command: 'uvx', args: ['mcp-server-git@0.6.2'] })),
    ).toMatchObject({
      runtime: 'python',
      package: 'mcp-server-git',
      version: '0.6.2',
    });
  });

  it('unwraps a client config with mcpServers or servers and takes the first server', () => {
    const inner = { command: 'npx', args: ['pkg@1.0.0'] };
    for (const key of ['mcpServers', 'servers']) {
      expect(
        importSnippet(JSON.stringify({ [key]: { a: inner, b: { url: 'https://x' } } })),
      ).toMatchObject({
        runtime: 'npm',
        package: 'pkg',
      });
    }
  });

  it('reads a remote URL, from the config or from the remotes of a server.json', () => {
    expect(importSnippet(JSON.stringify({ url: 'https://mcp.example.com/mcp' }))).toMatchObject({
      runtime: 'remote',
      url: 'https://mcp.example.com/mcp',
    });
    expect(
      importSnippet(
        JSON.stringify({ remotes: [{ type: 'streamable-http', url: 'https://r.example/mcp' }] }),
      ),
    ).toMatchObject({ runtime: 'remote', url: 'https://r.example/mcp' });
  });

  it('says what is wrong with what was pasted', () => {
    expect(importSnippet('{ nope')).toEqual({ error: 'Paste valid JSON' });
    expect(importSnippet('null')).toEqual({ error: 'Paste a JSON object' });
    expect(importSnippet('7')).toEqual({ error: 'Paste a JSON object' });
    expect(importSnippet(JSON.stringify({ command: 'docker', args: ['run'] }))).toEqual({
      error: 'Only npx, uvx and remote URLs can be imported',
    });
    expect(importSnippet(JSON.stringify({ command: 'npx', args: ['-y'] }))).toEqual({
      error: 'No package found in args',
    });
    expect(importSnippet(JSON.stringify({ remotes: [] }))).toEqual({
      error: 'Only npx, uvx and remote URLs can be imported',
    });
  });
});
