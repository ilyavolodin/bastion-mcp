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

export type MaintenanceView = { enabled: boolean; since: string | null; by: string | null };

export type RestoreView = {
  mode: 'merge' | 'replace';
  dryRun: boolean;
  backup: { createdAt: string; migration: string | null };
  tables: Record<
    string,
    { rows: number; existing: number; action: 'restore' | 'skip'; note?: string }
  >;
  warnings: string[];
};

export type BackupView = {
  filename: string;
  size: number;
  createdAt: string;
  counts: Record<string, number>;
  /** The sealed backup file, base64. */
  data: string;
};

export interface SystemStatusPort {
  status(): Promise<SystemStatus>;
  rotateKms(): Promise<{ kekRef: string; rewrapped: number }>;
  rotateSigningKeys(): Promise<{ kids: string[] }>;
  /** Full encrypted backup of the installation (writes its own `backup.export` audit event). */
  createBackup(input: { passphrase: string; actorId: string }): Promise<BackupView>;
  /** Restores a backup (base64); `dryRun` only reports. A replace needs maintenance mode. */
  restoreBackup(input: {
    data: string;
    passphrase: string;
    mode: 'merge' | 'replace';
    dryRun: boolean;
    actorId: string;
  }): Promise<RestoreView>;
  maintenance(): Promise<MaintenanceView>;
  setMaintenance(input: { enabled: boolean; actorId: string }): Promise<MaintenanceView>;
}
