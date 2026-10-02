export type SystemStatus = {
  replicas: Array<{ id: string; role: string; startedAt: string; version: string }>;
  leases: { active: number; byInstallation?: Record<string, number> };
  queues: Record<string, { depth: number; oldestAgeSeconds?: number }>;
  driver: { name: string; healthy: boolean; detail?: string };
  registrySync: Array<{
    sourceId: string;
    name: string;
    lastSyncAt: string | null;
    ok: boolean | null;
    error?: string;
  }>;
  kms: { provider: string; healthy: boolean; kekRef: string | null; lastRotatedAt: string | null };
  configVersion: string;
};

export interface SystemStatusPort {
  status(): Promise<SystemStatus>;
  rotateKms(): Promise<{ kekRef: string; rewrapped: number }>;
  rotateSigningKeys(): Promise<{ kids: string[] }>;
}
