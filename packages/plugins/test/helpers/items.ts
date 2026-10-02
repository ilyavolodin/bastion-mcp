import {
  type MarketplaceInfo,
  type MarketplaceRow,
  type PluginFile,
  parsePluginManifest,
  type ReleaseItem,
  type ResolvedReleaseItem,
  textFile,
} from '../../src';

export const SKILL_MD = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: Does ${name} things\n${extra}---\n# ${name}\n\nBody.\n`;

export const marketplaceInfo: MarketplaceInfo = {
  slug: 'acme-tools',
  displayName: 'Acme Tools',
  description: 'Acme approved plugins',
  ownerName: 'Acme',
};

export const marketplaceRow = (over: Partial<MarketplaceRow> = {}): MarketplaceRow => ({
  id: '11111111-1111-7111-8111-111111111111',
  slug: 'acme-tools',
  displayName: 'Acme Tools',
  description: 'Acme approved plugins',
  ownerName: 'Acme',
  desktopInstallation: 'available',
  promotedRelease: null,
  mirror: null,
  mirrorStatus: null,
  ...over,
});

export const reviewItem = (): ReleaseItem => ({
  name: 'code-review',
  version: '1.2.0',
  policy: 'installedByDefault',
  manifest: parsePluginManifest({
    name: 'code-review',
    version: '1.2.0',
    description: 'Review code',
    displayName: 'Code Review',
    skills: [
      { kind: 'inline', path: 'skills/review' },
      { kind: 'ref', slug: 'style-guide' },
    ],
    mcpServers: [
      { kind: 'bastion', slug: 'github' },
      { kind: 'remote', name: 'docs', url: 'https://docs.example.com/mcp' },
    ],
    claude: { pluginJson: { author: { name: 'Acme' } } },
    openai: { extensions: { category: 'Engineering' } },
  }),
  files: [
    textFile('skills/review/SKILL.md', SKILL_MD('review')),
    textFile('skills/review/references/checklist.md', '# Checklist\n'),
    textFile('claude/commands/review.md', 'Review the diff.\n'),
    textFile('openai/apps.json', '{"apps":[]}\n'),
  ],
  skills: [
    {
      slug: 'style-guide',
      name: 'style-guide',
      files: [
        textFile('SKILL.md', SKILL_MD('style-guide')),
        textFile('assets/rules.txt', 'rules\n'),
      ],
    },
  ],
});

export const toolboxItem = (): ReleaseItem => ({
  name: 'toolbox',
  version: '0.3.1',
  policy: 'required',
  manifest: parsePluginManifest({
    name: 'toolbox',
    version: '0.3.1',
    description: 'Local helpers',
    displayName: 'Toolbox',
    skills: [{ kind: 'inline', path: 'skills/lint' }],
    mcpServers: [
      { kind: 'stdio', name: 'lint', command: 'node', args: ['server.js'], env: { MODE: 'ci' } },
    ],
  }),
  files: [
    textFile('skills/lint/SKILL.md', SKILL_MD('lint')),
    textFile('skills/lint/scripts/run.sh', '#!/bin/sh\necho lint\n', 'executable'),
  ],
  skills: [],
});

export const plainItem = (): ReleaseItem => ({
  name: 'notes',
  version: '1.0.0',
  policy: 'available',
  manifest: parsePluginManifest({
    name: 'notes',
    version: '1.0.0',
    description: 'Note taking',
    displayName: 'Notes',
    skills: [{ kind: 'inline', path: 'skills/notes' }],
  }),
  files: [textFile('skills/notes/SKILL.md', SKILL_MD('notes'))],
  skills: [],
});

export const sampleItems = (): ReleaseItem[] => [reviewItem(), toolboxItem(), plainItem()];

export const asResolved = (items: ReleaseItem[]): ResolvedReleaseItem[] =>
  items.map((i, n) => ({ ...i, entryId: `entry-${n}`, versionId: `version-${n}-${i.version}` }));

export const RELEASE_TIME = new Date('2026-10-01T12:00:00Z');

export const paths = (files: readonly PluginFile[]): string[] => files.map((f) => f.path);
