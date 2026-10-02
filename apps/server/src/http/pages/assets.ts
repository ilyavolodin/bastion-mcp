import type { FastifyInstance } from 'fastify';
import { PAGES_CSS, PAGES_THEME_JS } from './css';
import { POPPINS_WOFF2_BASE64 } from './fonts.generated';

const FONTS = new Map(
  Object.entries(POPPINS_WOFF2_BASE64).map(([weight, base64]) => [
    `poppins-latin-${weight}.woff2`,
    Buffer.from(base64, 'base64'),
  ]),
);

/**
 * Serves the stylesheet, the theme script and the self-hosted Poppins files of the server-rendered pages. The
 * stylesheet and script URLs carry a content hash (`?v=`), so they are cached for a year.
 */
export const registerPageAssets = async (app: FastifyInstance): Promise<void> => {
  app.get('/assets/pages.css', async (_req, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(PAGES_CSS),
  );
  app.get('/assets/pages-theme.js', async (_req, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(PAGES_THEME_JS),
  );
  app.get<{ Params: { file: string } }>('/assets/fonts/:file', async (req, reply) => {
    const font = FONTS.get(req.params.file);
    if (!font) return reply.code(404).type('application/json').send({ error: 'not_found' });
    return reply
      .type('font/woff2')
      .header('cache-control', 'public, max-age=604800')
      .header('access-control-allow-origin', '*')
      .send(font);
  });
};
