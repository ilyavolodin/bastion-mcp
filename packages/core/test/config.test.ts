import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfigFile } from '../src/config';

const base = {
  BASTION_PUBLIC_URL: 'https://mcp.acme.com',
  BASTION_DATABASE_URL: 'postgres://u:p@localhost:5432/bastion',
  BASTION_REDIS_URL: 'redis://localhost:6379',
  BASTION_INTERNAL_SECRET: 'x'.repeat(32),
  BASTION_KMS_KEY: '/keys/kek',
};

describe('19.1 configuration loader', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base);
    expect(c.role).toBe('all');
    expect(c.httpPort).toBe(8080);
    expect(c.internalPort).toBe(7443);
    expect(c.egressPort).toBe(3128);
    expect(c.databasePoolMax).toBe(20);
    expect(c.kms).toBe('local');
    expect(c.sandbox.driver).toBe('bubblewrap');
    expect(c.sandbox.namespace).toBe('bastion-sandboxes');
    expect(c.sandbox.runtimeClass).toBe('gvisor');
    expect(c.maxRunningSandboxes).toBe(500);
    expect(c.maxRunningInstancesPerUser).toBe(10);
    expect(c.npmRegistry).toBe('https://registry.npmjs.org');
    expect(c.pypiIndexUrl).toBe('https://pypi.org/simple');
    expect(c.osvCheck).toBe(true);
    expect(c.legacyMaxSessionsPerPrincipal).toBe(20);
    expect(c.listCacheTtlMs).toBe(300_000);
    expect(c.listPageSize).toBe(1000);
    expect(c.expectedWorkers).toBe(3);
    expect(c.traceSampleRatio).toBe(1);
    expect(c.otelCaptureContent).toBe(false);
    expect(c.logLevel).toBe('info');
    expect(c.dataDir).toBe('/var/lib/bastion');
    expect(c.localLogin).toBe(false);
  });

  it('derives issuer and resource URIs from the public URL, without a trailing slash', () => {
    const c = loadConfig({ ...base, BASTION_PUBLIC_URL: 'https://mcp.acme.com/' });
    expect(c.publicUrl).toBe('https://mcp.acme.com');
    expect(c.urls.issuer).toBe('https://mcp.acme.com/oauth');
    expect(c.urls.mcpResource).toBe('https://mcp.acme.com/mcp');
    expect(c.urls.apiResource).toBe('https://mcp.acme.com/api');
  });

  it('refuses to start and lists every invalid value', () => {
    try {
      loadConfig({
        BASTION_INTERNAL_SECRET: 'short',
        BASTION_ROLE: 'nope',
        BASTION_HTTP_PORT: 'abc',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).issues.map((i) => i.path).join(',');
      expect(msg).toContain('BASTION_PUBLIC_URL');
      expect(msg).toContain('BASTION_DATABASE_URL');
      expect(msg).toContain('BASTION_REDIS_URL');
      expect(msg).toContain('BASTION_INTERNAL_SECRET');
      expect(msg).toContain('BASTION_ROLE');
      expect(msg).toContain('BASTION_HTTP_PORT');
    }
  });

  it('parses booleans, CSV lists and the kubernetes default driver override', () => {
    const c = loadConfig({
      ...base,
      BASTION_OSV_CHECK: 'false',
      BASTION_LOCAL_LOGIN: 'true',
      BASTION_CLUSTER_CIDRS: '10.0.0.0/8, 172.20.0.0/16',
      BASTION_INSECURE_UPSTREAM_HOSTS: 'localhost',
      BASTION_SANDBOX_DRIVER: 'kubernetes',
    });
    expect(c.osvCheck).toBe(false);
    expect(c.localLogin).toBe(true);
    expect(c.clusterCidrs).toEqual(['10.0.0.0/8', '172.20.0.0/16']);
    expect(c.insecureUpstreamHosts).toEqual(['localhost']);
    expect(c.sandbox.driver).toBe('kubernetes');
  });

  it('requires the KMS key unless the kms provider is local with a generated key', () => {
    const { BASTION_KMS_KEY: _omit, ...noKey } = base;
    expect(() => loadConfig({ ...noKey, BASTION_KMS: 'aws' })).toThrow(ConfigError);
  });

  it('rejects an internal secret shorter than 32 bytes', () => {
    expect(() => loadConfig({ ...base, BASTION_INTERNAL_SECRET: 'x'.repeat(31) })).toThrow(
      ConfigError,
    );
  });

  it('requires https public URLs outside localhost', () => {
    expect(() => loadConfig({ ...base, BASTION_PUBLIC_URL: 'http://mcp.acme.com' })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ ...base, BASTION_PUBLIC_URL: 'http://localhost:8080' }),
    ).not.toThrow();
  });

  it('merges a YAML file under the environment, environment winning', () => {
    const fromFile = parseConfigFile('BASTION_HTTP_PORT: 9000\nBASTION_LOG_LEVEL: debug\n');
    const c = loadConfig({ ...base, BASTION_LOG_LEVEL: 'warn' }, fromFile);
    expect(c.httpPort).toBe(9000);
    expect(c.logLevel).toBe('warn');
  });

  it('exposes role helpers', () => {
    expect(loadConfig({ ...base, BASTION_ROLE: 'worker' }).roles).toEqual({
      worker: true,
      ui: false,
    });
    expect(loadConfig({ ...base, BASTION_ROLE: 'ui' }).roles).toEqual({ worker: false, ui: true });
    expect(loadConfig(base).roles).toEqual({ worker: true, ui: true });
  });
});
