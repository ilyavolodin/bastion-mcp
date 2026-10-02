import { describe, expect, it } from 'vitest';
import { ROLLOUT_CLIENTS, renderRollout } from '../src';
import { expectGolden, marketplaceRow } from './helpers/fixtures';

const release = {
  seq: 4,
  items: [
    { name: 'code-review', version: '1.2.0', policy: 'installedByDefault' as const },
    { name: 'toolbox', version: '0.3.1', policy: 'required' as const },
    { name: 'notes', version: '1.0.0', policy: 'available' as const },
  ],
  gitCommit: 'c'.repeat(40),
  claudeManifestSha256: 'a'.repeat(64),
  agentsManifestSha256: 'b'.repeat(64),
  archives: {},
  releaseTime: '2026-10-01T12:00:00.000Z',
};
const options = { host: 'mcp.example.com', credentialHelperPath: '/usr/local/bin' };
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

describe('25.7 rollout configuration', () => {
  const mp = marketplaceRow({ promotedRelease: 4, desktopInstallation: 'auto_install' });

  it('25.7 claude-code: extraKnownMarketplaces, enabledPlugins for required items, allowlist entry, credential line, install commands', () => {
    const out = renderRollout(mp, release, 'claude-code', options);
    expectGolden('rollout/claude-code.json', json(out));
    expect(out).toMatchObject({
      managedSettings: {
        extraKnownMarketplaces: {
          'acme-tools': {
            source: { source: 'git', url: 'https://mcp.example.com/plugins/acme-tools.git' },
            autoUpdate: true,
          },
        },
        enabledPlugins: { 'toolbox@acme-tools': true },
      },
      strictKnownMarketplacesEntry: {
        source: 'git',
        url: 'https://mcp.example.com/plugins/acme-tools.git',
      },
      gitCredentialLine:
        'git config --global credential.https://mcp.example.com.helper "/usr/local/bin/bastion-credential"',
      installCommands: ['claude plugin install code-review@acme-tools'],
    });
  });

  it('25.7 claude-desktop-3p: git entry pinned to the promoted release commit with the credential helper', () => {
    const out = renderRollout(mp, release, 'claude-desktop-3p', options);
    expect(out).toEqual({
      client: 'claude-desktop-3p',
      allowedPluginMarketplaces: {
        gitEntry: {
          source: 'git',
          url: 'https://mcp.example.com/plugins/acme-tools.git',
          ref: 'c'.repeat(40),
          credentialKind: 'credentialHelper',
          credentialHelper: '/usr/local/bin/bastion-credential',
          installationPreference: 'auto_install',
        },
      },
    });
  });

  it('25.7 claude-desktop-3p: the url form carries manifestSha256 for devices without git', () => {
    const out = renderRollout(mp, release, 'claude-desktop-3p', {
      ...options,
      httpsManifestSha256: 'e'.repeat(64),
    });
    expectGolden('rollout/claude-desktop-3p.json', json(out));
    expect(out).toMatchObject({
      allowedPluginMarketplaces: {
        urlEntry: {
          source: 'url',
          url: 'https://mcp.example.com/plugins/acme-tools/marketplace.json?release=4',
          manifestSha256: 'e'.repeat(64),
          credentialKind: 'credentialHelper',
          installationPreference: 'auto_install',
        },
      },
    });
  });

  it('25.7 claude-desktop-3p requires the promoted release', () => {
    expect(() =>
      renderRollout(marketplaceRow({ promotedRelease: 3 }), release, 'claude-desktop-3p', options),
    ).toThrow(/promote/);
    expect(() =>
      renderRollout(
        marketplaceRow({ promotedRelease: null }),
        release,
        'claude-desktop-3p',
        options,
      ),
    ).toThrow(/promote/);
  });

  it('25.7 codex: marketplace add command, credential line and requirements.toml fragment', () => {
    const out = renderRollout(mp, release, 'codex', { host: 'mcp.example.com' });
    expectGolden('rollout/codex.json', json(out));
    expect(out).toMatchObject({
      commands: ['codex plugin marketplace add https://mcp.example.com/plugins/acme-tools.git'],
      requirementsToml: [
        '[marketplaces]',
        'restrict_to_allowed_sources = true',
        '',
        '[marketplaces.allowed_sources.acme-tools]',
        'source = "git"',
        'url = "https://mcp.example.com/plugins/acme-tools.git"',
        '',
      ].join('\n'),
    });
    expect((out as { gitCredentialLine: string }).gitCredentialLine).toContain(
      '<path>/bastion-credential',
    );
  });

  it('25.7 claude-ai and chatgpt: checklists with the availability to set per plugin', () => {
    const withMirror = marketplaceRow({
      mirror: { provider: 'github', repo: 'acme/mirror', branch: 'main', credentialSecretId: 's' },
    });
    const claudeAi = renderRollout(withMirror, release, 'claude-ai', options);
    expectGolden('rollout/claude-ai.json', json(claudeAi));
    expect(claudeAi).toMatchObject({
      plugins: [
        { name: 'code-review', setTo: 'Installed by default' },
        { name: 'toolbox', setTo: 'Required' },
        { name: 'notes', setTo: 'Available' },
      ],
    });
    expect((claudeAi as { steps: string[] }).steps[0]).toContain('https://github.com/acme/mirror');
    expect((claudeAi as { steps: string[] }).steps[2]).toContain('https://mcp.example.com/mcp');
    const chatgpt = renderRollout(withMirror, release, 'chatgpt', options);
    expect((chatgpt as { steps: string[] }).steps.join(' ')).toMatch(/Desktop only/);
    const gitlab = renderRollout(
      marketplaceRow({
        mirror: { provider: 'gitlab', repo: 'g/m', branch: 'main', credentialSecretId: 's' },
      }),
      release,
      'claude-ai',
      options,
    );
    expect((gitlab as { steps: string[] }).steps[0]).toContain('https://gitlab.com/g/m');
    for (const client of ['claude-ai', 'chatgpt'] as const) {
      expect(
        (renderRollout(marketplaceRow(), release, client, options) as { steps: string[] }).steps[0],
      ).toMatch(/mirror target/);
    }
  });

  it('25.7 supports every documented client', () => {
    expect(ROLLOUT_CLIENTS).toEqual([
      'claude-code',
      'claude-desktop-3p',
      'codex',
      'claude-ai',
      'chatgpt',
    ]);
  });
});
