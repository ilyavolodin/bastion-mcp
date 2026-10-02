import { PluginStateError } from './errors';
import type { MarketplaceRow } from './ports';
import type { ReleaseRecord } from './release';
import { baseUrl, type ItemPolicy } from './render';

export const ROLLOUT_CLIENTS = ['claude-code', 'claude-desktop-3p', 'codex', 'claude-ai', 'chatgpt'] as const;
export type RolloutClient = (typeof ROLLOUT_CLIENTS)[number];

export type RolloutOptions = {
  host: string;
  /** Path of the credential helper on user machines; shown as `<path>/bastion-credential`. */
  credentialHelperPath?: string;
  /** SHA-256 of the HTTPS manifest bytes of this release (for the Desktop `url` form). */
  httpsManifestSha256?: string;
};

const POLICY_LABEL: Record<ItemPolicy, string> = {
  required: 'Required',
  installedByDefault: 'Installed by default',
  available: 'Available',
};

export type RolloutConfig =
  | {
      client: 'claude-code';
      managedSettings: {
        extraKnownMarketplaces: Record<
          string,
          { source: { source: 'git'; url: string }; autoUpdate: true }
        >;
        enabledPlugins: Record<string, true>;
      };
      strictKnownMarketplacesEntry: { source: 'git'; url: string };
      gitCredentialLine: string;
      /** `installedByDefault` items: Claude Code has no removable default (25.7). */
      installCommands: string[];
    }
  | {
      client: 'claude-desktop-3p';
      allowedPluginMarketplaces: {
        gitEntry: Record<string, string>;
        urlEntry?: Record<string, string>;
      };
    }
  | {
      client: 'codex';
      commands: string[];
      gitCredentialLine: string;
      requirementsToml: string;
    }
  | { client: 'claude-ai' | 'chatgpt'; steps: string[]; plugins: { name: string; setTo: string }[] };

const mirrorUrl = (m: MarketplaceRow): string | undefined =>
  m.mirror
    ? `https://${m.mirror.provider === 'github' ? 'github.com' : 'gitlab.com'}/${m.mirror.repo}`
    : undefined;

const gitUrl = (host: string, slug: string): string => `${baseUrl(host)}/plugins/${slug}.git`;

const credentialLine = (host: string, helper: string): string =>
  `git config --global credential.${baseUrl(host)}.helper "${helper}"`;

/**
 * Copy-ready client configuration for a marketplace release (25.7). Pass the latest release, or the
 * promoted release where a pin is needed; `claude-desktop-3p` requires the promoted one.
 */
export const renderRollout = (
  marketplace: MarketplaceRow,
  release: ReleaseRecord,
  client: RolloutClient,
  options: RolloutOptions,
): RolloutConfig => {
  const { slug } = marketplace;
  const url = gitUrl(options.host, slug);
  const helper = `${options.credentialHelperPath ?? '<path>'}/bastion-credential`;
  const line = credentialLine(options.host, helper);

  switch (client) {
    case 'claude-code':
      return {
        client,
        managedSettings: {
          extraKnownMarketplaces: { [slug]: { source: { source: 'git', url }, autoUpdate: true } },
          enabledPlugins: Object.fromEntries(
            release.items.filter((i) => i.policy === 'required').map((i) => [`${i.name}@${slug}`, true as const]),
          ),
        },
        strictKnownMarketplacesEntry: { source: 'git', url },
        gitCredentialLine: line,
        installCommands: release.items
          .filter((i) => i.policy === 'installedByDefault')
          .map((i) => `claude plugin install ${i.name}@${slug}`),
      };
    case 'claude-desktop-3p': {
      if (marketplace.promotedRelease !== release.seq) {
        throw new PluginStateError(
          'RELEASE_NOT_PROMOTED',
          'Claude Desktop configuration pins a promoted release; promote this release first',
          409,
        );
      }
      const common = {
        credentialKind: 'credentialHelper',
        credentialHelper: helper,
        installationPreference: marketplace.desktopInstallation,
      };
      return {
        client,
        allowedPluginMarketplaces: {
          gitEntry: { source: 'git', url, ref: release.gitCommit, ...common },
          ...(options.httpsManifestSha256
            ? {
                urlEntry: {
                  source: 'url',
                  url: `${baseUrl(options.host)}/plugins/${slug}/marketplace.json?release=${release.seq}`,
                  manifestSha256: options.httpsManifestSha256,
                  ...common,
                },
              }
            : {}),
        },
      };
    }
    case 'codex':
      return {
        client,
        commands: [`codex plugin marketplace add ${url}`],
        gitCredentialLine: line,
        requirementsToml: [
          '[marketplaces]',
          'restrict_to_allowed_sources = true',
          '',
          `[marketplaces.allowed_sources.${slug}]`,
          'source = "git"',
          `url = "${url}"`,
          '',
        ].join('\n'),
      };
    case 'claude-ai': {
      const mirror = mirrorUrl(marketplace);
      return {
        client,
        steps: [
          mirror
            ? `Add ${mirror} under Organization settings > Plugins & skills > Marketplaces.`
            : 'Configure a mirror target for this marketplace first (GitHub or GitLab).',
          'Set each plugin\'s availability to the value listed below.',
          `Optional: add ${baseUrl(options.host)}/mcp as an organization custom connector.`,
        ],
        plugins: release.items.map((i) => ({ name: i.name, setTo: POLICY_LABEL[i.policy] })),
      };
    }
    case 'chatgpt': {
      const mirror = mirrorUrl(marketplace);
      return {
        client,
        steps: [
          mirror
            ? `Admin > Plugins > Import marketplace with ${mirror}.`
            : 'Configure a GitHub mirror target for this marketplace first.',
          "Set each plugin's installation policy per role to match the list below.",
          'Plugins that declare MCP servers will show as Desktop only.',
        ],
        plugins: release.items.map((i) => ({ name: i.name, setTo: POLICY_LABEL[i.policy] })),
      };
    }
  }
};
