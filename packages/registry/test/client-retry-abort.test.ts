import { describe, expect, it } from 'vitest';
import { createRegistryClient, RegistryUnavailableError } from '../src';

const failing = async (): Promise<Response> => new Response('x', { status: 503 });

describe('11.6 retry backoff is abortable', () => {
  it('11.6 aborting during the backoff wait rejects promptly as unavailable', async () => {
    const client = createRegistryClient({
      baseUrl: 'https://registry.example',
      fetch: failing,
      retries: 3,
      retryDelayMs: 60_000,
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.listServersPage({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
