import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { SandboxStartFailedError } from '@bastion-mcp/core';
import { RedisEgressPolicyStore } from '@bastion-mcp/mcp-upstream';
import {
  BubblewrapDriver,
  createClientNodeKubeApi,
  createEgressProxy,
  type EgressProxy,
  type IsolationLevel,
  KubernetesDriver,
  type SandboxDriver,
  type SandboxHandle,
} from '@bastion-mcp/sandbox';
import seccompProfile from '../../../../deploy/docker/sandbox-seccomp.json';
import type { DriverState } from '../contracts';
import type { Infra } from '../infra';

/** A driver that reports why the real one could not be built; every start fails with a clear message (8.5). */
class UnavailableDriver implements SandboxDriver {
  readonly isolation: IsolationLevel = 'namespaces';
  constructor(
    readonly name: 'kubernetes' | 'bubblewrap',
    readonly reason: string,
  ) {}
  private fail(): never {
    throw new SandboxStartFailedError(`${this.name} sandbox driver unavailable: ${this.reason}`, {
      installation: 'unknown',
      phase: 'claiming',
    });
  }
  async create(): Promise<SandboxHandle> {
    return this.fail();
  }
  async attach(): Promise<SandboxHandle> {
    return this.fail();
  }
  async suspend(): Promise<void> {}
  async destroy(): Promise<void> {}
  async *list() {}
}

/** The address sandboxes use to reach this worker's egress proxy: `BASTION_EGRESS_HOST`, the pod IP, or the host name. */
export const egressHost = (infra: Infra): string => {
  const explicit = process.env.BASTION_EGRESS_HOST ?? infra.options.advertiseHost;
  if (explicit) return explicit;
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) if (nic.family === 'IPv4' && !nic.internal) return nic.address;
  }
  return '127.0.0.1';
};

export type SandboxStack = {
  driver: SandboxDriver;
  driverState(): Promise<DriverState>;
  egress: EgressProxy;
  /** `host:port` that `HTTPS_PROXY` points at inside the sandbox (8.8). */
  egressAddress: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Selects the sandbox driver from `BASTION_SANDBOX_DRIVER` and builds the egress proxy (8.8): TCP on
 * `BASTION_EGRESS_PORT` for Kubernetes (authenticated by `Proxy-Authorization`), one Unix socket per jail for
 * bubblewrap (the runner forwards `127.0.0.1:3128` inside the jail to that socket). `options.sandboxDriver`
 * replaces the driver (tests). A driver that cannot be built (bubblewrap on a host without it, a missing cluster
 * config) degrades to `UnavailableDriver`: the worker keeps serving remote upstreams and the status shows why.
 */
export const createSandboxStack = async (infra: Infra): Promise<SandboxStack> => {
  const { config } = infra;
  const egress = createEgressProxy({
    policies: new RedisEgressPolicyStore(infra.redis),
    audit: {
      record: async (event) => {
        try {
          await infra.repos.egressEvents.record(event);
        } catch (error) {
          infra.logger.warn({ err: String(error) }, 'egress audit write failed');
        }
        infra.metrics.egressConnections.add(1, { decision: event.decision });
      },
    },
    clusterCidrs: config.clusterCidrs,
    mirrorUrls: [config.npmRegistry, config.pypiIndexUrl],
  });

  let driver: SandboxDriver;
  let state: () => Promise<DriverState>;
  let egressAddress = `${egressHost(infra)}:${config.egressPort}`;
  let tcp: { close(): Promise<void> } | undefined;
  let tcpWanted = false;

  if (infra.options.sandboxDriver) {
    driver = infra.options.sandboxDriver;
    state = async () => ({ name: driver.name, healthy: true, detail: 'injected driver' });
  } else if (config.sandbox.driver === 'kubernetes') {
    tcpWanted = true;
    try {
      const k8s = await import('@kubernetes/client-node');
      const kc = new k8s.KubeConfig();
      try {
        kc.loadFromCluster();
      } catch {
        kc.loadFromDefault();
      }
      driver = new KubernetesDriver({
        api: createClientNodeKubeApi(kc, config.sandbox.namespace),
        namespace: config.sandbox.namespace,
        isolation: config.sandbox.runtimeClass.includes('kata') ? 'kata' : 'gvisor',
      });
      state = async () => ({
        name: 'kubernetes',
        healthy: true,
        detail: `namespace ${config.sandbox.namespace}, runtime class ${config.sandbox.runtimeClass}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      driver = new UnavailableDriver('kubernetes', reason);
      state = async () => ({ name: 'kubernetes', healthy: false, detail: reason });
    }
  } else {
    egressAddress = '127.0.0.1:3128';
    try {
      const bwrap = new BubblewrapDriver({
        dataDir: config.dataDir,
        seccompProfile,
        egress,
        runnerPath: process.env.BASTION_RUNNER_PATH ?? '/opt/bastion/runner.mjs',
        runtimeDir: process.env.BASTION_RUNTIME_DIR ?? join('/opt', 'runtime'),
      });
      driver = bwrap;
      state = async () => {
        const probe = await bwrap.status();
        return probe.status === 'available'
          ? { name: 'bubblewrap', healthy: true }
          : { name: 'bubblewrap', healthy: false, detail: probe.error };
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      driver = new UnavailableDriver('bubblewrap', reason);
      state = async () => ({ name: 'bubblewrap', healthy: false, detail: reason });
    }
  }

  return {
    driver,
    driverState: state,
    egress,
    egressAddress,
    async start() {
      if (tcpWanted) {
        tcp = await egress.listenTcp(config.egressPort, infra.options.listenHost ?? '0.0.0.0');
      }
    },
    async stop() {
      await tcp?.close().catch(() => undefined);
      await egress.close().catch(() => undefined);
    },
  };
};
