import { MS } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { createInstallationRegistry } from '../src/adapters/upstream/installations';
import { fakeInfra, manualClock } from './fake-infra';

const harness = () => {
  const clock = manualClock();
  const loads: string[] = [];
  let listener: ((raw: string) => void) | undefined;
  const infra = fakeInfra({
    clock,
    logger: { warn: () => undefined },
    pubsub: {
      subscribe: (_channel: string, l: (raw: string) => void) => {
        listener = l;
        return () => undefined;
      },
    },
    repos: {
      installationRegistry: {
        get: async (id: string) => {
          loads.push(id);
          return id === 'missing' ? null : { id, slug: id };
        },
      },
    },
    db: {
      prisma: {
        installation: {
          findUnique: async () => ({ ownerType: 'team', ownerId: 'team-1' }),
        },
      },
    },
  });
  return { clock, loads, infra, emit: (message: object) => listener?.(JSON.stringify(message)) };
};

describe('4.3 installation registry cache (TtlCache with the infra clock)', () => {
  it('serves repeated lookups from the cache within the TTL and reloads after it', async () => {
    const h = harness();
    const registry = createInstallationRegistry(h.infra);
    await registry.get('a');
    await registry.get('a');
    expect(h.loads).toEqual(['a']);
    h.clock.advance(30 * MS.SECOND + 1);
    await registry.get('a');
    expect(h.loads).toEqual(['a', 'a']);
  });

  it('caches a missing installation as null', async () => {
    const h = harness();
    const registry = createInstallationRegistry(h.infra);
    expect(await registry.get('missing')).toBeNull();
    expect(await registry.get('missing')).toBeNull();
    expect(h.loads).toEqual(['missing']);
  });

  it('derives notify targets from the owner', async () => {
    const h = harness();
    const resolved = await createInstallationRegistry(h.infra).get('a');
    expect(resolved).toMatchObject({ notifyTargets: { teamIds: ['team-1'] } });
  });

  it('drops one entry on an installation event and everything on a wider one', async () => {
    const h = harness();
    const registry = createInstallationRegistry(h.infra);
    registry.watch();
    await registry.get('a');
    await registry.get('b');
    h.emit({ scope: 'installation', id: 'a' });
    await registry.get('a');
    await registry.get('b');
    expect(h.loads).toEqual(['a', 'b', 'a']);
    h.emit({ scope: 'org' });
    await registry.get('a');
    await registry.get('b');
    expect(h.loads).toEqual(['a', 'b', 'a', 'a', 'b']);
  });

  it('invalidates by id or entirely', async () => {
    const h = harness();
    const registry = createInstallationRegistry(h.infra);
    await registry.get('a');
    registry.invalidate('a');
    await registry.get('a');
    registry.invalidate();
    await registry.get('a');
    expect(h.loads).toEqual(['a', 'a', 'a']);
  });
});
