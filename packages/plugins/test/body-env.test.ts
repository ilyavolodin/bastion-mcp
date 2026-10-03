import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readBodyCapped } from '../src/body';
import { gitEnv } from '../src/git-env';
import { createWorld } from './helpers/world';

const chunked = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      const next = chunks[i++];
      if (next) c.enqueue(next);
      else c.close();
    },
  });
};

describe('25.5 bounded request bodies', () => {
  it('25.5 reads a body within the cap', async () => {
    const out = await readBodyCapped(chunked([new Uint8Array([1, 2]), new Uint8Array([3])]), 3);
    expect([...out]).toEqual([1, 2, 3]);
    expect((await readBodyCapped(null, 3)).byteLength).toBe(0);
  });

  it('25.5 aborts a chunked body that overflows the cap without reading it all', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(4));
      },
    });
    await expect(readBodyCapped(stream, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBeLessThan(10);
  });

  it('25.5 answers 413 for a declared oversize body', async () => {
    const world = await createWorld();
    try {
      await world.service.publish(world.marketplace.id);
      const res = await world.handler(
        new Request('https://mcp.example.com/plugins/acme-tools.git/git-upload-pack', {
          method: 'POST',
          headers: {
            authorization: 'Bearer good-token',
            'content-length': String(65 * 1024 * 1024),
          },
          body: 'x',
        }),
      );
      expect(res?.status).toBe(413);
    } finally {
      await world.close();
    }
  });

  it('25.5 answers 400 for a malformed ?release and 404 for an unknown one', async () => {
    const world = await createWorld();
    try {
      await world.service.publish(world.marketplace.id);
      const headers = { authorization: 'Bearer good-token' };
      const url = 'https://mcp.example.com/plugins/acme-tools/marketplace.json';
      expect((await world.handler(new Request(`${url}?release=abc`, { headers })))?.status).toBe(
        400,
      );
      expect((await world.handler(new Request(`${url}?release=9`, { headers })))?.status).toBe(404);
      const ok = await world.handler(new Request(`${url}?release=1`, { headers }));
      expect(ok?.headers.get('x-bastion-release')).toBe('1');
    } finally {
      await world.close();
    }
  });
});

describe('24.2 git child processes get an allowlisted environment', () => {
  it('24.2 keeps PATH/HOME/LANG and git settings, drops everything else', () => {
    const env = gitEnv(
      { PATH: '/bin', HOME: '/h', LANG: 'C', AWS_SECRET_ACCESS_KEY: 'x', DATABASE_URL: 'y' },
      { GIT_TERMINAL_PROMPT: '0' },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', GIT_TERMINAL_PROMPT: '0' });
  });
});
