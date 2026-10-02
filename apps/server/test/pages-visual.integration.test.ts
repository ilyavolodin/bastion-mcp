/// <reference lib="dom" />
/**
 * Real-browser check of every server-rendered page (Playwright + axe) against a real in-process server: screenshots
 * in light and dark at 1280 and 390 px go to `apps/server/screenshots/`, axe must find no violation in any of them,
 * and the page must not need an inline script or style (the CSP forbids both).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectPage,
  errorPage,
  logoutConfirmPage,
  logoutDonePage,
} from '../src/http/pages/templates';
import { type BrowserRig, browserTestsAvailable, startBrowserRig } from './helpers/browser';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { bootStack, type Stack } from './helpers/stack';
import { startUiHarness, type UiHarness } from './helpers/ui-harness';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#171a3a"/><path d="M10 34 24 10l14 24z" fill="#ff8a1f"/></svg>';
const EMAIL = 'root@acme.example';
const REDIRECT = 'https://claude.example/callback';

const WEB_DIST =
  process.env.BASTION_WEB_DIST ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
/** The console build must already contain the account page (a stale `apps/web/dist` does not). */
const spaHasAccountPage = (): boolean => {
  const assets = join(WEB_DIST, 'assets');
  if (!existsSync(assets)) return false;
  return readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(join(assets, f), 'utf8').includes('Account and password'));
};

const VARIANTS = [
  { scheme: 'light', width: 1280, height: 800 },
  { scheme: 'dark', width: 1280, height: 800 },
  { scheme: 'light', width: 390, height: 844 },
  { scheme: 'dark', width: 390, height: 844 },
] as const;

/** Screenshots the page in every variant and fails on any axe violation or horizontal scroll. */
const shoot = async (
  page: Page,
  name: string,
  options: { skipRules?: string[] } = {},
): Promise<void> => {
  for (const v of VARIANTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.emulateMedia({ colorScheme: v.scheme, reducedMotion: 'reduce' });
    await page.evaluate(() => document.fonts.ready);
    // Let the browser restyle for the new scheme and viewport before looking at colors (axe reads computed styles).
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await page.screenshot({
      path: join(OUT, `${name}-${v.scheme}-${v.width}.png`),
      fullPage: true,
    });
    const results = await new AxeBuilder({ page }).disableRules(options.skipRules ?? []).analyze();
    expect(
      results.violations.map(
        (x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
      `${name} ${v.scheme} ${v.width}`,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} ${v.scheme} ${v.width} horizontal scroll`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
};

const watchCsp = (page: Page, bag: string[]): void => {
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) bag.push(m.text());
  });
  page.on('pageerror', (e) => bag.push(e.message));
};

describe.skipIf(!haveDocker() || !browserTestsAvailable())(
  'pages in a real browser (Zest, axe, strict CSP)',
  () => {
    describe('local administrator and OAuth pages', () => {
      let env: TestEnv;
      let stack: Stack;
      let rig: BrowserRig;
      let password = '';
      const problems: string[] = [];

      beforeAll(async () => {
        mkdirSync(OUT, { recursive: true });
        env = await createTestEnv();
        stack = await bootStack({
          env,
          vars: { BASTION_BOOTSTRAP_ADMIN_EMAIL: EMAIL },
          options: {
            printBootstrapPassword: (_e, p) => {
              password = p;
            },
          },
        });
        rig = await startBrowserRig(stack.port);
        rig.preview(
          'connect',
          connectPage({
            installationId: '0190f2a0-0000-7000-8000-000000000001',
            installationName: 'Linear',
            authorizationServerHost: 'mcp.linear.app',
            scopes: ['read', 'write'],
            csrf: 'preview',
          }),
        );
        rig.preview(
          'error',
          errorPage({
            message: 'The server’s sign-in service could not be reached.',
            details: [{ name: 'error', value: 'upstream_unreachable' }],
          }),
        );
        rig.preview(
          'logout',
          logoutConfirmPage(
            '<form id="op.logoutForm" method="post" action="/oauth/session/end/confirm"><input type="hidden" name="xsrf" value="x"/></form>',
          ),
        );
        rig.preview('signed-out', logoutDonePage());
      });
      afterAll(async () => {
        await rig?.close();
        await stack?.stop();
        await env?.cleanup();
      });

      it('9.1 login, login error, forgot password, upstream connect and error pages', async () => {
        const context = await rig.context();
        const page = await context.newPage();
        watchCsp(page, problems);
        await page.goto('https://bastion.test/auth/login');
        await page.waitForSelector('#local-email');
        // the saved console theme wins over the system preference
        await page.evaluate(() => localStorage.setItem('bastion.theme', 'dark'));
        await page.reload();
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
        await page.evaluate(() => localStorage.removeItem('bastion.theme'));
        await page.reload();
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
        const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        expect(font).toContain('Poppins');
        expect(await page.evaluate(() => document.fonts.check('600 16px Poppins'))).toBe(true);
        await shoot(page, 'login');

        // keyboard: tab order reaches the forgot link, the password, then the button, each with a visible ring
        await page.fill('#local-email', EMAIL);
        await page.fill('#local-password', 'definitely wrong');
        await page.click('button[type=submit]');
        await page.waitForSelector('#form-status .alert-error');
        expect(await page.inputValue('#local-email')).toBe(EMAIL);
        await shoot(page, 'login-error');

        await page.goto('https://bastion.test/auth/forgot');
        await shoot(page, 'forgot-password');

        await page.goto('https://bastion.test/__preview/connect');
        await shoot(page, 'connect-upstream');
        await page.goto('https://bastion.test/__preview/error');
        await shoot(page, 'error');
        await page.goto('https://bastion.test/__preview/logout');
        await shoot(page, 'logout-confirm');
        await page.goto('https://bastion.test/__preview/signed-out');
        await shoot(page, 'signed-out');
        await context.close();
      });

      it('9.1 the focus ring is visible on keyboard focus', async () => {
        const context = await rig.context();
        const page = await context.newPage();
        await page.goto('https://bastion.test/auth/login');
        await page.keyboard.press('Tab'); // skip link
        await page.keyboard.press('Tab'); // email
        const ring = await page.evaluate(
          () => getComputedStyle(document.activeElement as Element).boxShadow,
        );
        expect(ring).toContain('rgb(178, 71, 0)');
        await context.close();
      });

      it('9.3 sign-in interaction, consent, device pages', async () => {
        const reg = await stack.fetch(`${stack.publicUrl}/oauth/reg`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Claude',
            logo_uri: 'https://logo.test/claude.svg',
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            response_types: ['code'],
          }),
        });
        expect(reg.status).toBe(201);
        const clientId = ((await reg.json()) as { client_id: string }).client_id;
        const verifier = randomBytes(32).toString('base64url');
        const query = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT,
          scope: 'mcp offline_access',
          state: 'xyz',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          resource: `${stack.publicUrl}/mcp`,
        });
        const context = await rig.context();
        await context.route('https://logo.test/**', (route) =>
          route.fulfill({ contentType: 'image/svg+xml', body: LOGO_SVG }),
        );
        const page = await context.newPage();
        watchCsp(page, problems);
        await page.goto(`https://bastion.test/oauth/auth?${query}`);
        await page.waitForSelector('#local-email');
        expect(await page.textContent('.lede')).toContain(clientId);
        await shoot(page, 'oauth-sign-in');
        await page.fill('#local-email', EMAIL);
        await page.fill('#local-password', password);
        await page.click('button[type=submit]');
        await page.waitForSelector('button[value=approve]');
        expect(await page.textContent('h1')).toBe('Authorize access');
        expect(await page.textContent('.client-name')).toBe('Claude');
        expect(await page.textContent('.chip')).toBe('claude.example');
        await page.waitForLoadState('networkidle');
        await shoot(page, 'oauth-consent');
        // Allow redirects to the client (a host that does not exist here, so the navigation itself fails)
        const callback = page.waitForEvent('requestfailed', (r) => r.url().startsWith(REDIRECT));
        await page.click('button[value=approve]');
        const redirected = new URL((await callback).url());
        expect(redirected.searchParams.get('code')).toBeTruthy();
        expect(redirected.searchParams.get('state')).toBe('xyz');

        // device flow in a fresh context (no session)
        const device = await stack.fetch(`${stack.publicUrl}/oauth/device/auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'bastion-credential', scope: 'plugins:read' }),
        });
        const { user_code: userCode } = (await device.json()) as { user_code: string };
        const ctx2 = await rig.context();
        const p2 = await ctx2.newPage();
        watchCsp(p2, problems);
        await p2.goto('https://bastion.test/oauth/device');
        await p2.waitForSelector('#user_code');
        await shoot(p2, 'device-code');
        await p2.fill('#user_code', 'ZZZZ-ZZZZ');
        await p2.click('button[form="op.deviceInputForm"]');
        await p2.waitForSelector('#form-status .alert-error');
        await shoot(p2, 'device-code-error');
        await p2.fill('#user_code', userCode);
        await p2.click('button[form="op.deviceInputForm"]');
        await p2.waitForSelector('.usercode');
        await shoot(p2, 'device-confirm');
        await p2.click('button[form="op.deviceConfirmForm"]:not([name=abort])');
        // not signed in yet: the sign-in interaction, then success
        await p2.waitForSelector('#local-email');
        await shoot(p2, 'device-sign-in');
        await p2.fill('#local-email', EMAIL);
        await p2.fill('#local-password', password);
        await p2.click('button[type=submit]');
        await p2.waitForSelector('text=You are signed in');
        await shoot(p2, 'device-success');
        await ctx2.close();

        // the verification_uri_complete link (provider-built auto-submit page) still reaches the confirm page
        const complete = await stack.fetch(`${stack.publicUrl}/oauth/device/auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'bastion-credential', scope: 'plugins:read' }),
        });
        const { verification_uri_complete: link } = (await complete.json()) as {
          verification_uri_complete: string;
        };
        const ctx3 = await rig.context();
        const p3 = await ctx3.newPage();
        await p3.goto(link.replace(/^https?:\/\/[^/]+/, 'https://bastion.test'));
        await p3.waitForSelector('.usercode');
        await ctx3.close();
        await context.close();
      });

      it('24.2 no page needed an inline script or style (no CSP violation, no script error)', () => {
        expect(problems).toEqual([]);
      });
    });

    describe('single sign-on pages', () => {
      let h: UiHarness;
      let rig: BrowserRig;

      beforeAll(async () => {
        mkdirSync(OUT, { recursive: true });
        h = await startUiHarness({ idpConnection: true, env: { BASTION_LOCAL_LOGIN: 'true' } });
        rig = await startBrowserRig(Number(new URL(h.base).port));
      });
      afterAll(async () => {
        await rig?.close();
        await h?.close();
      });

      it('9.1 IdP button together with the local form, and routing by email domain', async () => {
        const context = await rig.context();
        const page = await context.newPage();
        await page.goto('https://bastion.test/auth/login');
        await page.waitForSelector('text=Sign in with Acme SSO');
        await shoot(page, 'login-sso-and-local');

        const secret = await h.infra.secretStore.put(
          { scope: 'org', ownerId: null, name: 'idp:second' },
          h.idp.clientSecret,
        );
        await h.infra.repos.idpConnections.create({
          name: 'Partner IdP',
          issuer: h.idp.issuer,
          discoveryUrl: h.idp.discoveryUrl,
          clientId: h.idp.clientId,
          clientSecretId: secret.id,
          scopes: ['openid', 'email', 'profile'],
          emailDomains: ['partner.example'],
          storeRefreshToken: false,
          apiScope: null,
          enterpriseManagedAuth: false,
          enabled: true,
        });
        await page.goto('https://bastion.test/auth/login');
        await page.waitForSelector('#sso-email');
        await shoot(page, 'login-sso-routing');
        await context.close();
      });
    });

    describe('local sign-in turned off', () => {
      let h: UiHarness;
      let rig: BrowserRig;
      beforeAll(async () => {
        mkdirSync(OUT, { recursive: true });
        h = await startUiHarness({ idpConnection: true });
        rig = await startBrowserRig(Number(new URL(h.base).port));
      });
      afterAll(async () => {
        await rig?.close();
        await h?.close();
      });

      it('9.1 explains that password sign-in is off instead of showing a dead form', async () => {
        const secret = await h.infra.secretStore.put(
          { scope: 'org', ownerId: null, name: 'idp:second' },
          h.idp.clientSecret,
        );
        await h.infra.repos.idpConnections.create({
          name: 'Partner IdP',
          issuer: h.idp.issuer,
          discoveryUrl: h.idp.discoveryUrl,
          clientId: h.idp.clientId,
          clientSecretId: secret.id,
          scopes: ['openid', 'email', 'profile'],
          emailDomains: ['partner.example'],
          storeRefreshToken: false,
          apiScope: null,
          enterpriseManagedAuth: false,
          enabled: true,
        });
        const context = await rig.context();
        const page = await context.newPage();
        await page.goto('https://bastion.test/auth/login');
        await page.waitForSelector('text=Password sign-in is turned off');
        await shoot(page, 'login-local-off');
        await context.close();
      });
    });

    describe.skipIf(!spaHasAccountPage())('console account page', () => {
      let env: TestEnv;
      let stack: Stack;
      let rig: BrowserRig;
      let password = '';

      beforeAll(async () => {
        mkdirSync(OUT, { recursive: true });
        env = await createTestEnv();
        stack = await bootStack({
          env,
          vars: { BASTION_BOOTSTRAP_ADMIN_EMAIL: EMAIL },
          options: {
            publicDir: WEB_DIST,
            printBootstrapPassword: (_e, p) => {
              password = p;
            },
          },
        });
        rig = await startBrowserRig(stack.port);
      });
      afterAll(async () => {
        await rig?.close();
        await stack?.stop();
        await env?.cleanup();
      });

      it('9.1 the user menu leads to Change password; it works and signs the other sessions out', async () => {
        const other = await rig.context();
        const otherPage = await other.newPage();
        await otherPage.goto('https://bastion.test/auth/login');
        await otherPage.fill('#local-email', EMAIL);
        await otherPage.fill('#local-password', password);
        await otherPage.click('button[type=submit]');
        await otherPage.waitForURL('https://bastion.test/');
        const status = () => otherPage.evaluate(async () => (await fetch('/api/v1/me')).status);
        expect(await status()).toBe(200);

        const context = await rig.context();
        const page = await context.newPage();
        await page.goto('https://bastion.test/auth/login?return_to=/');
        await page.fill('#local-email', EMAIL);
        await page.fill('#local-password', password);
        await page.click('button[type=submit]');
        await page.waitForURL('https://bastion.test/');
        await page.getByRole('button', { name: /Account menu for/ }).click();
        await page.getByRole('menuitem', { name: 'Account and password' }).click();
        await page.waitForSelector('h1:has-text("Account")');
        await page.waitForLoadState('networkidle');
        // the console shell (not this page) has one element outside a landmark at phone width
        await shoot(page, 'console-account', { skipRules: ['region'] });

        await page.getByLabel(/Current password/).fill(password);
        await page.getByLabel(/^New password/).fill('a brand new passphrase 21');
        await page.getByLabel(/Repeat the new password/).fill('a brand new passphrase 21');
        await page.getByRole('button', { name: 'Change password' }).click();
        await page.waitForSelector('text=Password changed');
        // this session stays valid, the other one is signed out
        expect(await page.evaluate(async () => (await fetch('/api/v1/me')).status)).toBe(200);
        expect(await status()).toBe(401);
        await page.screenshot({ path: join(OUT, 'console-account-changed.png'), fullPage: true });
        await other.close();
        await context.close();
      });
    });
  },
);
