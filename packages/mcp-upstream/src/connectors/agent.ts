import { createHash } from 'node:crypto';
import { pinnedLookup, type SafeRemoteUrl } from '@bastion-mcp/sandbox';
import { Agent } from 'undici';

/** Per-installation `undici` Agents (8.9): keep-alive, 64 connections, 30 s connect timeout, custom CA and client cert. */

export type TlsMaterial = {
  ca?: string | undefined;
  cert?: string | undefined;
  key?: string | undefined;
};

export const AGENT_CONNECTIONS = 64;
export const AGENT_CONNECT_TIMEOUT_MS = 30_000;

const digest = (tls: TlsMaterial): string =>
  createHash('sha256')
    .update(`${tls.ca ?? ''}\0${tls.cert ?? ''}\0${tls.key ?? ''}`)
    .digest('hex')
    .slice(0, 16);

export class RemoteAgentRegistry {
  private readonly agents = new Map<string, Agent>();

  /**
   * One Agent per installation and resolved address. The connection is pinned to the address that passed the SSRF
   * check, so DNS rebinding cannot redirect it (8.9).
   */
  get(installationId: string, safe: SafeRemoteUrl, tls: TlsMaterial = {}): Agent {
    const key = `${installationId}|${safe.address}|${safe.port}|${digest(tls)}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    // A changed address or certificate replaces the installation's older agents.
    for (const [otherKey, agent] of this.agents) {
      if (otherKey.startsWith(`${installationId}|`)) {
        this.agents.delete(otherKey);
        void agent.close().catch(() => undefined);
      }
    }
    const agent = new Agent({
      connections: AGENT_CONNECTIONS,
      keepAliveTimeout: 30_000,
      connect: {
        timeout: AGENT_CONNECT_TIMEOUT_MS,
        lookup: pinnedLookup(safe),
        ...(tls.ca === undefined ? {} : { ca: tls.ca }),
        ...(tls.cert === undefined ? {} : { cert: tls.cert }),
        ...(tls.key === undefined ? {} : { key: tls.key }),
      },
    });
    this.agents.set(key, agent);
    return agent;
  }

  get size(): number {
    return this.agents.size;
  }

  async closeInstallation(installationId: string): Promise<void> {
    for (const [key, agent] of this.agents) {
      if (key.startsWith(`${installationId}|`)) {
        this.agents.delete(key);
        await agent.close().catch(() => undefined);
      }
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(all.map((agent) => agent.close().catch(() => undefined)));
  }
}
