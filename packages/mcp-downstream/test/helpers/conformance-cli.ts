import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type ConformanceReport = {
  /** Scenario id to its checks: `status` is SUCCESS, FAILURE, WARNING, SKIPPED or INFO. */
  scenarios: Record<string, { status: string; message?: string }[]>;
  exitCode: number | null;
  stdout: string;
};

/** Path of the pinned conformance CLI (`@modelcontextprotocol/conformance` 0.1.16). */
export const conformanceBin = (): string => {
  const pkg = require.resolve('@modelcontextprotocol/conformance/package.json');
  return pkg.replace(/package\.json$/, 'dist/index.js');
};

/** Runs `conformance server --url ...` for one scenario and parses the `[scenario] ... SUCCESS/FAILURE` summary. */
export const runConformanceScenario = (
  url: string,
  scenario: string,
  timeoutMs = 60_000,
): Promise<ConformanceReport> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [conformanceBin(), 'server', '--url', url, '--scenario', scenario, '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`conformance scenario ${scenario} timed out`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ scenarios: parseChecks(stdout, scenario), exitCode: code, stdout });
    });
  });

const parseChecks = (output: string, scenario: string): ConformanceReport['scenarios'] => {
  const checks: { status: string; message?: string }[] = [];
  const jsonStart = output.indexOf('[');
  const jsonEnd = output.lastIndexOf(']');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as unknown;
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (typeof c === 'object' && c !== null && 'status' in c) {
            const check = c as { status: string; errorMessage?: string };
            checks.push({
              status: check.status,
              ...(check.errorMessage === undefined ? {} : { message: check.errorMessage }),
            });
          }
        }
      }
    } catch {
      // fall through to the exit code
    }
  }
  return { [scenario]: checks };
};
