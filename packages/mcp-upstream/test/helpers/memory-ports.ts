import type { ServerSpec } from '@bastion-mcp/core';
import type {
  CallPrincipal,
  ConnectUrlBuilder,
  InstallationRegistry,
  InstallationStatusSink,
  InstanceRecord,
  InstanceRepository,
  ResolvedCredential,
  ResolvedInstallation,
  RunnerTokenStore,
  SnapshotItems,
  SnapshotStore,
  UpstreamCredentialProvider,
} from '../../src/ports';
import { AuthRequiredError } from '../../src/ports';

export class MemoryInstanceRepository implements InstanceRepository {
  readonly rows = new Map<string, InstanceRecord>();

  async get(instanceId: string) {
    const row = this.rows.get(instanceId);
    return row ? structuredClone(row) : null;
  }
  async getForInstallation(installationId: string) {
    for (const row of this.rows.values()) {
      if (row.installationId === installationId) return structuredClone(row);
    }
    return null;
  }
  async listShared(catalogVersionId: string) {
    return [...this.rows.values()]
      .filter((r) => r.installationId === null && r.catalogVersionId === catalogVersionId)
      .map((r) => structuredClone(r));
  }
  async save(record: InstanceRecord) {
    this.rows.set(record.id, structuredClone(record));
  }
  async listRunning(userId?: string) {
    return [...this.rows.values()]
      .filter((r) => r.sandbox !== undefined && (userId === undefined || r.userId === userId))
      .map((r) => structuredClone(r));
  }
  async delete(instanceId: string) {
    this.rows.delete(instanceId);
  }
}

export class MemoryTokenStore implements RunnerTokenStore {
  readonly tokens = new Map<string, string>();
  async save(instanceId: string, runnerToken: string) {
    this.tokens.set(instanceId, runnerToken);
  }
  async load(instanceId: string) {
    return this.tokens.get(instanceId) ?? null;
  }
  async delete(instanceId: string) {
    this.tokens.delete(instanceId);
  }
}

export class MemoryStatusSink implements InstallationStatusSink {
  readonly errors = new Map<string, { phase: string; message: string; stderrTail: string[] }>();
  readonly cleared: string[] = [];
  async markError(
    installationId: string,
    detail: { phase: string; message: string; stderrTail: string[] },
  ) {
    this.errors.set(installationId, detail);
  }
  async clearError(installationId: string) {
    this.errors.delete(installationId);
    this.cleared.push(installationId);
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly snapshots = new Map<string, SnapshotItems>();
  readonly references = new Map<string, SnapshotItems>();
  puts = 0;
  async get(installationId: string, configHash: string) {
    return this.snapshots.get(`${installationId}:${configHash}`) ?? null;
  }
  async getReference(catalogVersionId: string, configHash: string) {
    return this.references.get(`${catalogVersionId}:${configHash}`) ?? null;
  }
  async put(installationId: string, configHash: string, items: SnapshotItems) {
    this.puts += 1;
    this.snapshots.set(`${installationId}:${configHash}`, items);
  }
}

export class MemoryInstallations implements InstallationRegistry {
  readonly map = new Map<string, ResolvedInstallation>();
  add(installation: ResolvedInstallation) {
    this.map.set(installation.installationId, installation);
    return installation;
  }
  async get(installationId: string) {
    return this.map.get(installationId) ?? null;
  }
}

export class FakeCredentials implements UpstreamCredentialProvider {
  authRequired = false;
  hash = 'cred-1';
  async resolve(
    _principal: CallPrincipal,
    _installation: ResolvedInstallation,
    _spec: ServerSpec,
  ): Promise<ResolvedCredential> {
    if (this.authRequired) throw new AuthRequiredError();
    return { injections: [], credentialHash: this.hash };
  }
}

export const connectUrls: ConnectUrlBuilder = {
  connectUrl: (_principal, installationId) =>
    `https://bastion.test/connect/${installationId}?state=abc`,
};
