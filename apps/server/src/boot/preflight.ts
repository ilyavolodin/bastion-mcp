import pg from 'pg';
import { type MigrationStatus, migrationStatus } from './migrate';

export class PendingMigrationsError extends Error {
  constructor(readonly status: MigrationStatus) {
    super(
      `database migrations pending: ${[...status.pending, ...status.failed].join(', ')}; run "bastion migrate"`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Boot guard (20.1): refuse to start against a database that is behind the bundled migrations. */
export const assertMigrationsCurrent = async (databaseUrl: string): Promise<MigrationStatus> => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const status = await migrationStatus(client);
    if (status.pending.length > 0 || status.failed.length > 0) {
      throw new PendingMigrationsError(status);
    }
    return status;
  } finally {
    await client.end().catch(() => undefined);
  }
};
