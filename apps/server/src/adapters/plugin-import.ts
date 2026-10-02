import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import type { PluginImportPort } from '@bastion-mcp/api';
import { BastionError, isAddressDenied, normalizeIpLiteral } from '@bastion-mcp/core';
import {
  discoverItems,
  extractSubtree,
  importFromGit,
  importZip,
  type PluginFile,
  PluginValidationError,
  readGitTree,
} from '@bastion-mcp/plugins';
import type { Infra } from '../infra';
import { draftFromFiles } from './plugin-content';

export class GitUrlDeniedError extends BastionError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, { httpStatus: 422 });
  }
}

/**
 * SSRF guard for git URLs (8.8, 25.3): https only, no credentials, and every address the host resolves to must be
 * public (or inside `BASTION_PRIVATE_UPSTREAM_CIDRS`). `allowInsecureHttp` (tests only) also permits http and local
 * paths.
 */
export const assertGitUrl = async (infra: Infra, raw: string): Promise<void> => {
  if (infra.options.allowInsecureHttp && existsSync(raw)) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GitUrlDeniedError('git URL is not a valid URL');
  }
  const insecure = infra.options.allowInsecureHttp === true;
  if (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:')) {
    throw new GitUrlDeniedError('git URL must use https');
  }
  if (url.username || url.password)
    throw new GitUrlDeniedError('git URL must not contain credentials');
  if (insecure) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host) ? host : normalizeIpLiteral(host);
  const addresses = literal
    ? [literal]
    : (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
  const policy = {
    allowCidrs: infra.config.privateUpstreamCidrs,
    clusterCidrs: infra.config.clusterCidrs,
  };
  const denied = addresses.find((a) => isAddressDenied(a, policy));
  if (denied) throw new GitUrlDeniedError(`git host resolves to a denied address (${denied})`);
};

/** Reads the tree of a git repository at a ref: over https, or from a local directory in tests. */
export const readRepository = async (
  infra: Infra,
  options: { url: string; ref: string; password?: string },
): Promise<{ commit: string; files: PluginFile[] }> => {
  await assertGitUrl(infra, options.url);
  if (infra.options.allowInsecureHttp && existsSync(options.url)) {
    const bare = existsSync(`${options.url}/HEAD`);
    return readGitTree({
      gitdir: bare ? options.url : `${options.url}/.git`,
      ref: options.ref,
    });
  }
  return importFromGit({
    url: options.url,
    ref: options.ref,
    ...(options.password ? { password: options.password } : {}),
  });
};

/**
 * Zip and git imports of skills and plugins (11.1, 25.2, 25.3). A repository that holds exactly one plugin or skill
 * imports as that item; marketplace repositories with several items are imported through plugin sources.
 */
export const createPluginImportPort = (infra: Infra): PluginImportPort => ({
  async fromZip(bytes) {
    return draftFromFiles(importZip(bytes), 'imported-plugin');
  },
  async fromGit(url, ref) {
    const tree = await readRepository(infra, { url, ref: ref ?? 'HEAD' });
    const items = discoverItems(tree.files).filter((i) => !i.external);
    if (items.length > 1) {
      throw new PluginValidationError(
        `the repository holds ${items.length} plugins; add it as a plugin source to import all of them`,
      );
    }
    const item = items[0];
    const files = item ? extractSubtree(tree.files, item.dir) : tree.files;
    const fallback = item?.name ?? basename(url).replace(/\.git$/, '');
    return draftFromFiles(files, fallback || 'imported-plugin');
  },
});
