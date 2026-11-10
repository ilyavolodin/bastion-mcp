import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { createMarketplaceRepository, createReleaseStore } from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const sha = '0'.repeat(64);

describe.skipIf(!dbEnabled())('25.4 release insert conflict', () => {
  const h = useTestDb();

  it('25.4 a repeated release seq is a 409 conflict naming the marketplace and the seq', async () => {
    const admin = createMarketplaceRepository(h.db.prisma);
    const m = await admin.create({
      slug: 'conflict-mkt',
      displayName: 'C',
      audience: {},
      createdBy: newId(),
    });
    const releases = createReleaseStore(h.db.prisma);
    const record = (seq: number) => ({
      seq,
      items: [],
      gitCommit: 'c'.repeat(40),
      claudeManifestSha256: sha,
      agentsManifestSha256: sha,
      archives: {},
      releaseTime: '2026-03-01T10:00:00.000Z',
    });
    await releases.insert(m.id, record(1), [], null);
    const error = await releases.insert(m.id, record(1), [], null).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      message: 'release already exists',
      data: { marketplaceId: m.id, seq: 1 },
    });
    expect((await releases.latest(m.id))?.seq).toBe(1);
  });
});
