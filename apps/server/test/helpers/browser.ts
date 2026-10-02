/**
 * Real-browser access to an in-process server. The server's public URL is `https://bastion.test` (the OAuth issuer
 * must be https), so a throwaway TLS front (a self-signed certificate made with `openssl`) listens locally and
 * forwards to the plain HTTP listener, and Chromium maps `bastion.test` to it. The front can also serve
 * `/__preview/<name>` documents (pages that need state the test does not build, rendered with the real templates);
 * everything they load (stylesheet, fonts, theme script) still comes from the real server.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';

export const opensslAvailable = (): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const chromiumAvailable = (): boolean => {
  try {
    return chromium.executablePath() !== '' && readFileSync(chromium.executablePath()).length > 0;
  } catch {
    return false;
  }
};

export const browserTestsAvailable = (): boolean => opensslAvailable() && chromiumAvailable();

export type BrowserRig = {
  browser: Browser;
  /** A new context at the given viewport and color scheme. */
  context(options?: {
    width?: number;
    height?: number;
    colorScheme?: 'light' | 'dark';
  }): Promise<BrowserContext>;
  /** Registers HTML that `https://bastion.test/__preview/<name>` returns. */
  preview(name: string, html: string): void;
  open(context: BrowserContext, path: string): Promise<Page>;
  close(): Promise<void>;
};

export const startBrowserRig = async (serverPort: number): Promise<BrowserRig> => {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=bastion.test',
      '-addext',
      'subjectAltName=DNS:bastion.test',
    ],
    { stdio: 'ignore' },
  );
  const previews = new Map<string, string>();
  const front = https.createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => {
      const path = req.url ?? '/';
      const preview = /^\/__preview\/([\w-]+)/.exec(path)?.[1];
      if (preview !== undefined) {
        const body = previews.get(preview);
        res.writeHead(body === undefined ? 404 : 200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data:",
        });
        res.end(body ?? 'not found');
        return;
      }
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: serverPort,
          method: req.method,
          path,
          headers: {
            ...req.headers,
            host: 'bastion.test',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'bastion.test',
          },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502).end();
      });
      req.pipe(upstream);
    },
  );
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const frontPort = (front.address() as AddressInfo).port;
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP bastion.test 127.0.0.1:${frontPort}`],
  });
  return {
    browser,
    preview: (name, html) => void previews.set(name, html),
    context: (options = {}) =>
      browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
        colorScheme: options.colorScheme ?? 'light',
      }),
    async open(context, path) {
      const page = await context.newPage();
      await page.goto(`https://bastion.test${path}`);
      return page;
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
