import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSpa } from '../src/http/shell';

/** A browser reload of a console route must get the SPA, even when the path shares a prefix with an API (24.2). */
describe('24.2 the SPA fallback', () => {
  const build = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bastion-spa-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    const app = Fastify();
    await registerSpa(app, { publicUrl: 'http://localhost', publicDir: dir });
    return app;
  };
  const get = async (url: string, accept = 'text/html') =>
    (await build()).inject({ method: 'GET', url, headers: { accept } });

  it('serves index.html for console routes that live below an API prefix', async () => {
    for (const url of [
      '/registry',
      '/plugins/marketplace/abc',
      '/plugins/edit/abc',
      '/catalog/x',
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
    }
  });

  it('still answers JSON 404 for unknown API paths', async () => {
    for (const url of ['/api/v1/nope', '/registry/v0.1/nope', '/plugins/some.git/info', '/mcp/x']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });
});
