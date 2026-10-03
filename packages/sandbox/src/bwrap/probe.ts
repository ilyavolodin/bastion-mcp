import { execFile } from 'node:child_process';
import { SANDBOX_TIMEOUTS_MS } from '../timeouts';

/**
 * Startup probe of 8.5: `bwrap --unshare-user --unshare-net true`. The root is bound read-only so `true` exists in
 * the jail: with no binds bwrap starts an empty filesystem and `execvp true` fails even where bubblewrap works.
 */

export type ProbeResult = { status: 'available' } | { status: 'unavailable'; error: string };

export type ExecProbe = (
  command: string,
  args: string[],
) => Promise<{ code: number | null; stderr: string; error?: string }>;

export const PROBE_ARGS = [
  '--unshare-user',
  '--unshare-net',
  '--ro-bind',
  '/',
  '/',
  'true',
] as const;

export const execProbe: ExecProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: SANDBOX_TIMEOUTS_MS.probe }, (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr });
      const code = typeof error.code === 'number' ? error.code : null;
      resolve({ code, stderr, error: error.message });
    });
  });

/** When it fails the driver reports `unavailable` with the error text; package installs are disabled in the UI. */
export const probeBwrap = async (
  exec: ExecProbe = execProbe,
  bwrapPath = 'bwrap',
): Promise<ProbeResult> => {
  const result = await exec(bwrapPath, [...PROBE_ARGS]);
  if (result.code === 0 && !result.error) return { status: 'available' };
  const text = (result.stderr || result.error || `exit code ${result.code}`).trim();
  return { status: 'unavailable', error: text };
};
