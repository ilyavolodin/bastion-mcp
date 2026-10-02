import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const run = (env: Record<string, string>) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './src/otel-register.ts',
      '-e',
      "const { trace } = require('@opentelemetry/api'); const s = trace.getTracer('t').startSpan('x'); console.log('RECORDING=' + s.isRecording()); s.end();",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OTEL_EXPORTER_OTLP_TIMEOUT: '200', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

describe('15.1 otel-register entry', () => {
  it('15.1 starts the SDK in the first import via node --import and exits cleanly', {
    timeout: 40_000,
  }, () => {
    const res = run({ BASTION_TRACE_SAMPLE_RATIO: '1' });
    expect(res.stderr).not.toContain('ECONNREFUSED');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RECORDING=true');
  });

  it('15.1 does nothing when OTEL_SDK_DISABLED=true', () => {
    const res = run({ OTEL_SDK_DISABLED: 'true' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RECORDING=false');
  });
});
