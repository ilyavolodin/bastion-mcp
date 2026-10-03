const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'] as const;

/**
 * Environment for a git child process: only what git needs from the parent, plus the settings the caller passes
 * explicitly. The server's secrets (database URL, KMS keys, tokens) never reach git or its helpers (24.2).
 */
export const gitEnv = (
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};
