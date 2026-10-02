import { execFile } from 'node:child_process';
import type { GitProvider, MirrorPushResult, MirrorTarget } from './ports';

type RunResult = { code: number; stdout: string; stderr: string };

const run = (
  git: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      git,
      args,
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export type GitBinaryProviderOptions = {
  gitBinary?: string;
  timeoutMs?: number;
  /** Maps a target to its remote URL; defaults to github.com and gitlab.com over HTTPS. */
  urlFor?: (target: MirrorTarget) => string;
};

const defaultUrl = (target: MirrorTarget): string =>
  target.provider === 'github'
    ? `https://github.com/${target.repo}.git`
    : `https://gitlab.com/${target.repo}.git`;

/**
 * `GitProvider` over the git binary: GitHub App installation tokens (`x-access-token`) and GitLab
 * project access tokens (`oauth2`) travel in an `Authorization` header set through the environment,
 * never in argv. Pushes are plain (no `--force`), so a diverged remote is rejected (25.5).
 */
export const createGitBinaryProvider = (options: GitBinaryProviderOptions = {}): GitProvider => {
  const git = options.gitBinary ?? 'git';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const urlFor = options.urlFor ?? defaultUrl;
  const envFor = (target: MirrorTarget, token: string): NodeJS.ProcessEnv => {
    const user = target.provider === 'github' ? 'x-access-token' : 'oauth2';
    const basic = Buffer.from(`${user}:${token}`).toString('base64');
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  };
  return {
    async getBranchHead(target, token) {
      const result = await run(
        git,
        ['ls-remote', urlFor(target), `refs/heads/${target.branch}`],
        envFor(target, token),
        timeoutMs,
      );
      if (result.code !== 0)
        throw new Error(`git ls-remote failed: ${result.stderr.trim().slice(0, 300)}`);
      const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
      return line ? (line.split(/\s+/)[0] ?? null) : null;
    },
    async push(target, token, input): Promise<MirrorPushResult> {
      const result = await run(
        git,
        [
          '--git-dir',
          input.gitdir,
          'push',
          urlFor(target),
          `${input.commit}:refs/heads/${target.branch}`,
          ...input.tags.map((t) => `refs/tags/${t}:refs/tags/${t}`),
        ],
        envFor(target, token),
        timeoutMs,
      );
      if (result.code === 0) return { status: 'pushed' };
      if (/non-fast-forward|fetch first|\[rejected\]/.test(result.stderr)) {
        return { status: 'rejected-non-fast-forward' };
      }
      throw new Error(`git push failed: ${result.stderr.trim().slice(0, 300)}`);
    },
  };
};
