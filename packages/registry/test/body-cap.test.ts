import { describe, expect, it } from 'vitest';
import {
  createNpmVersionResolver,
  createRegistryClient,
  RegistryInvalidResponseError,
} from '../src';
import { readBodyCapped } from '../src/body';

const streamOf = (chunks: string[], onPull?: () => void): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      const chunk = chunks[i];
      i += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
};

describe('11.6 response size cap', () => {
  it('readBodyCapped rejects a declared content-length above the cap without reading', async () => {
    let pulled = false;
    const response = new Response(
      streamOf(['{}'], () => {
        pulled = true;
      }),
      { headers: { 'content-length': '999999' } },
    );
    await expect(readBodyCapped(response, 100)).rejects.toThrow(/too large/);
    expect(pulled).toBe(false);
  });

  it('readBodyCapped stops reading a stream without content-length once the cap is crossed', async () => {
    let pulls = 0;
    const response = new Response(streamOf(Array(1000).fill('x'.repeat(10)), () => (pulls += 1)));
    await expect(readBodyCapped(response, 100)).rejects.toThrow(/too large/);
    expect(pulls).toBeLessThan(20);
  });

  it('readBodyCapped returns the text of a small body', async () => {
    expect(await readBodyCapped(new Response('{"a":1}'), 100)).toBe('{"a":1}');
  });

  it('the registry client refuses an oversized list response', async () => {
    const fetchFn = async () =>
      new Response(streamOf(Array(100).fill('x'.repeat(50))), { status: 200 });
    const client = createRegistryClient({
      baseUrl: 'https://registry.example',
      fetch: fetchFn,
      maxBodyBytes: 200,
    });
    await expect(client.listServersPage()).rejects.toBeInstanceOf(RegistryInvalidResponseError);
  });

  it('the npm resolver refuses an oversized packument', async () => {
    const fetchFn = async () =>
      new Response(streamOf(Array(100).fill('x'.repeat(50))), { status: 200 });
    const npm = createNpmVersionResolver('https://npm.example', {
      fetch: fetchFn,
      maxBodyBytes: 200,
    });
    await expect(npm.latest('npm', 'left-pad')).rejects.toBeInstanceOf(
      RegistryInvalidResponseError,
    );
  });
});
