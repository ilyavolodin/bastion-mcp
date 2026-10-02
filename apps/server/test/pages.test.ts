import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PAGES_CSS, PAGES_THEME_JS, THEME_STORAGE_KEY } from '../src/http/pages/css';
import { POPPINS_WOFF2_BASE64 } from '../src/http/pages/fonts.generated';
import { escapeHtml, html, raw, safeImageUrl } from '../src/http/pages/html';
import { bastionProviderPages } from '../src/http/pages/provider-pages';
import {
  connectPage,
  consentPage,
  deviceCodePage,
  deviceConfirmPage,
  deviceSuccessPage,
  errorPage,
  forgotPasswordPage,
  loginPage,
  logoutConfirmPage,
  logoutDonePage,
} from '../src/http/pages/templates';
import { COLORS, GRADIENTS, RADII, SHADOWS, SPACING } from '../src/http/pages/tokens';

const here = dirname(fileURLToPath(import.meta.url));
const tokensFile = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'docs', 'design', 'zest-tokens.json'), 'utf8'),
) as {
  color: { tokens: { name: string; value: string | { light: string; dark: string } }[] };
  radius: { tokens: { name: string; value: string }[] };
  spacing: { tokens: { name: string; value: string }[] };
  shadow: { tokens: { name: string; value: { light: string; dark: string } }[] };
  gradient: { tokens: { name: string; value: string }[] };
};

/** Every page the server renders, with benign data. */
const samplePages = (): Record<string, string> => ({
  'login (local only)': loginPage({
    returnTo: '/servers',
    connections: [],
    local: { enabled: true, csrf: 'csrf-token' },
  }),
  'login (idp + local)': loginPage({
    returnTo: '/',
    connections: [{ id: 'c1', name: 'Acme SSO' }],
    local: { enabled: true, csrf: 'csrf-token' },
  }),
  'login (two idps)': loginPage({
    returnTo: '/',
    connections: [
      { id: 'c1', name: 'Acme SSO' },
      { id: 'c2', name: 'Partner IdP' },
    ],
    local: { enabled: false, csrf: 'csrf-token' },
  }),
  'login (error)': loginPage({
    returnTo: '/',
    connections: [],
    local: { enabled: true, csrf: 'csrf-token', email: 'root@acme.test' },
    message: { kind: 'error', title: 'Sign-in failed', body: 'Try again.' },
  }),
  forgot: forgotPasswordPage({ idpNames: ['Acme SSO'], localEnabled: true, host: 'bastion.test' }),
  consent: consentPage({
    uid: 'uid1',
    csrf: 'csrf-token',
    clientName: 'Claude',
    logoUri: 'https://example.com/logo.png',
    redirectHost: 'claude.ai',
    scopes: ['mcp', 'offline_access'],
  }),
  connect: connectPage({
    installationId: 'i1',
    installationName: 'Linear',
    authorizationServerHost: 'linear.app',
    scopes: ['read'],
    csrf: 'csrf-token',
  }),
  error: errorPage({ message: 'Nope.', details: [{ name: 'error', value: 'invalid_request' }] }),
  'device code': deviceCodePage({
    form: '<form id="op.deviceInputForm" novalidate method="post" action="/oauth/device"><input type="hidden" name="xsrf" value="x"/><input type="text" name="user_code" placeholder="Enter code" onfocus="this.select(); this.onfocus = undefined;" autofocus autocomplete="off"></input></form>',
    error: 'wrong',
  }),
  'device confirm': deviceConfirmPage({
    clientName: 'Credential helper',
    logoUri: null,
    userCode: 'ABCD-EFGH',
    form: '<form id="op.deviceConfirmForm" method="post" action="/oauth/device"><input type="hidden" name="xsrf" value="x"/></form>',
  }),
  'device success': deviceSuccessPage('Credential helper'),
  'logout confirm': logoutConfirmPage('<form id="op.logoutForm" method="post"></form>'),
  'logout done': logoutDonePage(),
});

const ALLOWED_ATTRIBUTES = new Set([
  'class',
  'id',
  'href',
  'src',
  'alt',
  'for',
  'name',
  'type',
  'value',
  'action',
  'method',
  'form',
  'autocomplete',
  'autofocus',
  'required',
  'autocapitalize',
  'spellcheck',
  'inputmode',
  'minlength',
  'novalidate',
  'placeholder',
  'role',
  'lang',
  'charset',
  'content',
  'rel',
  'as',
  'crossorigin',
  'width',
  'height',
  'viewbox',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linejoin',
  'stroke-linecap',
  'd',
  'cx',
  'cy',
  'r',
  'focusable',
  'referrerpolicy',
  'pattern',
  'title',
  'aria-hidden',
  'aria-label',
  'aria-labelledby',
  'aria-live',
  'aria-atomic',
  'aria-describedby',
  'aria-invalid',
  'xmlns',
]);
/**
 * Tokenizes the whole document with a strict grammar: text without `<`, tags whose attributes are double-quoted
 * values without `"`, `<` or `>` and whose names are on a short list (no handlers, no `style`). A value that
 * broke out of its context would fail to tokenize or introduce a name that is not allowed.
 */
const assertWellFormed = (page: string): void => {
  const body = page.replace(/^<!doctype html>\s*/, '');
  const tag = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9:-]*(?:="[^"<>]*")?)*)\s*(\/?)>/giy;
  let position = 0;
  while (position < body.length) {
    const next = body.indexOf('<', position);
    const text = body.slice(position, next === -1 ? body.length : next);
    expect(text).not.toMatch(/[>]/);
    if (next === -1) break;
    tag.lastIndex = next;
    const m = tag.exec(body);
    expect(m, `untokenizable markup near: ${body.slice(next, next + 80)}`).not.toBeNull();
    if (!m) return;
    for (const attr of (m[3] ?? '').matchAll(/\s+([a-z][a-z0-9:-]*)(?:="[^"]*")?/gi)) {
      expect(ALLOWED_ATTRIBUTES.has((attr[1] ?? '').toLowerCase()), `attribute ${attr[1]}`).toBe(
        true,
      );
    }
    if (m[2] === 'script' && m[1] === '') expect(m[3]).toContain(' src="/assets/pages-theme.js');
    position = tag.lastIndex;
  }
};

describe('9.1 the strict tokenizer used by the XSS tests', () => {
  it('9.1 rejects markup an unescaped value would produce', () => {
    for (const bad of [
      '<p title=""><img src=x onerror=alert(1)>">x</p>',
      '<p title="x" onclick="y">x</p>',
      '<p>a > b</p>',
      '<script>alert(1)</script>',
    ]) {
      expect(() => assertWellFormed(bad), bad).toThrow();
    }
    expect(() => assertWellFormed('<p class="a">&lt;b&gt;</p>')).not.toThrow();
  });
});

describe('9.1 html builder', () => {
  it('9.1 escapes interpolated values and keeps SafeHtml and arrays intact', () => {
    const out = html`<p title="${'"><script>'}">${'<b>&</b>'}${raw('<i>ok</i>')}${[
      '<x>',
      html`<u>${'<y>'}</u>`,
    ]}</p>`.value;
    expect(out).toBe(
      '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;&lt;/b&gt;<i>ok</i>&lt;x&gt;<u>&lt;y&gt;</u></p>',
    );
  });

  it('9.1 property: escaped output never contains an angle bracket or quote from the value', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const out = escapeHtml(value);
        expect(out).not.toMatch(/[<>"']/);
        expect(out.replaceAll('&amp;', '&').replaceAll('&lt;', '<')).toBeTypeOf('string');
      }),
    );
  });

  it('9.3 only https image URLs are used for client logos', () => {
    expect(safeImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    for (const bad of ['http://x.test/a.png', 'javascript:alert(1)', 'data:text/html,x', 'x', 5]) {
      expect(safeImageUrl(bad)).toBeNull();
    }
  });
});

describe('9.1 pages escape every interpolated value (XSS)', () => {
  const payload = fc.oneof(
    fc.string(),
    fc.constantFrom(
      '"><img src=x onerror=alert(1)>',
      "'><script>alert(1)</script>",
      '</title><script>x</script>',
      '&lt;b&gt;',
      'javascript:alert(1)',
      '{{7*7}}',
    ),
  );
  const injected = (_value: string, page: string): void => assertWellFormed(page);

  it('9.3 consent page: client name, host, scopes and ids', () => {
    fc.assert(
      fc.property(payload, payload, payload, (a, b, c) => {
        const page = consentPage({
          uid: a,
          csrf: b,
          clientName: c,
          logoUri: `https://${a}`,
          redirectHost: b,
          scopes: [a, c],
        });
        for (const v of [a, b, c]) injected(v, page);
        if (a.length > 0 && !/[<>"'&]/.test(a)) expect(page).toContain(encodeURIComponent(a));
      }),
    );
  });

  it('9.1 login page: connection names, return path, email and messages', () => {
    fc.assert(
      fc.property(payload, payload, payload, (a, b, c) => {
        const page = loginPage({
          returnTo: a,
          connections: [
            { id: b, name: c },
            { id: a, name: b },
          ],
          local: { enabled: true, csrf: b, email: c },
          message: { kind: 'error', title: a, body: c },
          forClient: b,
        });
        for (const v of [a, b, c]) injected(v, page);
      }),
    );
  });

  it('9.6 connect, error and device pages', () => {
    fc.assert(
      fc.property(payload, payload, (a, b) => {
        const pages = [
          connectPage({
            installationId: a,
            installationName: b,
            authorizationServerHost: a,
            scopes: [b],
            csrf: a,
          }),
          errorPage({ message: a, title: b, details: [{ name: b, value: a }] }),
          deviceConfirmPage({ clientName: a, logoUri: b, userCode: b, form: '' }),
          deviceSuccessPage(a),
          forgotPasswordPage({ idpNames: [a, b], localEnabled: true, host: a }),
          bastionProviderPages.error({ error: a, description: b, details: { [b]: a } }),
        ];
        for (const page of pages) for (const v of [a, b]) injected(v, page);
      }),
    );
  });
});

describe('9.2 page structure and accessibility', () => {
  const pages = samplePages();

  it.each(Object.entries(pages))('%s: shared layout, strict-CSP-safe markup', (_name, page) => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<link rel="stylesheet" href="/assets/pages.css?v=');
    expect(page).toContain('<script src="/assets/pages-theme.js?v=');
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
    expect(page).toContain('<main id="main"');
    expect(page).toContain('class="skip" href="#main"');
    // nothing a script-less, style-less strict CSP would block
    expect(page).not.toMatch(/<style[\s>]/i);
    expect(page).not.toMatch(/\sstyle="/i);
    expect(page).not.toMatch(/\son[a-z]+="/i);
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(page).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import/);
    expect(page).not.toMatch(/https?:\/\/(?!example\.com)[a-z0-9.-]+\/[^"' ]*\.(css|js|woff2?)/i);
  });

  it.each(Object.entries(pages))(
    '%s: the document tokenizes under the strict grammar',
    (_name, page) => {
      assertWellFormed(page);
    },
  );

  it.each(Object.entries(pages))('%s: every visible input has a label', (_name, page) => {
    const inputs = [...page.matchAll(/<input\s[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/type="hidden"/.test(tag));
    for (const tag of inputs) {
      const id = /\sid="([^"]+)"/.exec(tag)?.[1];
      expect(id, tag).toBeDefined();
      expect(page, tag).toContain(`<label for="${id}">`);
    }
  });

  it('9.1 the sign-in form has username and current-password autocomplete and a live error region', () => {
    const page = pages['login (error)'] ?? '';
    expect(page).toMatch(/id="local-email"[^>]*autocomplete="username"/);
    expect(page).toMatch(/id="local-password"[^>]*autocomplete="current-password"/);
    expect(page).toContain('id="form-status" class="live" aria-live="assertive"');
    expect(page).toMatch(/role="alert"/);
    expect(page).toContain('aria-describedby="form-status"');
    expect(page).toContain('href="/auth/forgot"');
  });

  it('9.1 errors say what happened in text, not only color (icon plus title)', () => {
    const page = pages['login (error)'] ?? '';
    expect(page).toContain('<strong class="alert-title">Sign-in failed</strong>');
    expect(page).toMatch(/class="alert alert-error"[^>]*><svg[^>]*aria-hidden="true"/);
  });

  it('9.1 the IdP buttons read "Sign in with <name>" and route by email domain when several exist', () => {
    expect(pages['login (idp + local)']).toContain('Sign in with Acme SSO');
    expect(pages['login (two idps)']).toContain('name="email"');
    expect(pages['login (two idps)']).toContain('Sign in with Partner IdP');
  });

  it('9.1 local login off with an IdP shows a message instead of a dead form', () => {
    const page = pages['login (two idps)'] ?? '';
    expect(page).toContain('Password sign-in is turned off');
    expect(page).not.toContain('type="password"');
  });

  it('9.1 no sign-in method at all says so', () => {
    const page = loginPage({
      returnTo: '/',
      connections: [],
      local: { enabled: false, csrf: 'x' },
    });
    expect(page).toContain('No sign-in method is available');
    expect(page).not.toContain('type="password"');
  });

  it('9.3 consent names the client, the redirect host, the scopes and offers Allow and Deny', () => {
    const page = pages.consent ?? '';
    expect(page).toContain('<h1 id="page-title">Authorize access</h1>');
    expect(page).toContain('<span class="client-name">Claude</span>');
    expect(page).toContain('wants to access your Bastion account');
    expect(page).toContain('<strong class="chip">claude.ai</strong>');
    expect(page).toContain('Use your MCP servers through Bastion');
    expect(page).toContain('<code class="item-detail">offline_access</code>');
    expect(page).toMatch(/name="decision" value="approve">Allow</);
    expect(page).toMatch(/name="decision" value="deny">Deny</);
    expect(page).toContain('<img src="https://example.com/logo.png"');
  });

  it('9.6 connect names the upstream authorization server host before redirecting', () => {
    expect(pages.connect).toContain('<strong class="chip">linear.app</strong>');
    expect(pages.connect).toContain('Continue to linear.app');
  });

  it('9.3 the device code form loses its inline handler and gains a label', () => {
    const page = pages['device code'] ?? '';
    expect(page).not.toContain('onfocus');
    expect(page).toContain('<label for="user_code">');
    expect(page).toContain('id="user_code"');
    expect(page).toContain('form="op.deviceInputForm"');
    expect(page).toContain('That code is not right');
  });

  it('9.1 forgot-password explains the CLI, Docker and IdP options', () => {
    const page = pages.forgot ?? '';
    expect(page).toContain('bastion reset-password --email you@example.com');
    expect(page).toContain(
      'docker compose exec bastion bastion reset-password --email you@example.com',
    );
    expect(page).toContain('Acme SSO');
    expect(page).toContain('Change password');
  });
});

describe('9.2 generated stylesheet', () => {
  it('24.2 contains no remote URL, @import or inline-style dependency and self-hosts Poppins', () => {
    expect(PAGES_CSS).not.toMatch(/https?:\/\//);
    expect(PAGES_CSS).not.toContain('@import');
    for (const w of [400, 500, 600, 700]) {
      expect(PAGES_CSS).toContain(`url(/assets/fonts/poppins-latin-${w}.woff2)`);
    }
    expect(PAGES_CSS).toContain('@media (prefers-color-scheme:dark)');
    expect(PAGES_CSS).toContain(':root[data-theme="dark"]');
  });

  it('24.2 the embedded fonts are woff2 files', () => {
    for (const base64 of Object.values(POPPINS_WOFF2_BASE64)) {
      expect(Buffer.from(base64, 'base64').subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('18.1 the theme script reads the console theme key and nothing else', () => {
    expect(PAGES_THEME_JS).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(PAGES_THEME_JS).not.toContain('fetch');
  });

  it('18 the token values equal docs/design/zest-tokens.json', () => {
    for (const t of tokensFile.color.tokens) {
      if (typeof t.value !== 'object') continue;
      expect(COLORS[t.name], t.name).toEqual(t.value);
    }
    for (const t of tokensFile.shadow.tokens) {
      if (SHADOWS[t.name] !== undefined) expect(SHADOWS[t.name], t.name).toEqual(t.value);
    }
    for (const t of tokensFile.radius.tokens) expect(RADII[t.name], t.name).toBe(t.value);
    for (const t of tokensFile.spacing.tokens) expect(SPACING[t.name], t.name).toBe(t.value);
    for (const t of tokensFile.gradient.tokens) {
      if (GRADIENTS[t.name] !== undefined) expect(GRADIENTS[t.name], t.name).toBe(t.value);
    }
    // every design color used by the pages is in the stylesheet in both themes
    expect(PAGES_CSS).toContain('--canvas:#f4f5fa');
    expect(PAGES_CSS).toContain('--canvas:#121214');
    expect(PAGES_CSS).toContain(
      '--gradient-tangerine:linear-gradient(135deg, #ffc23d 0%, #ff8a1f 55%, #ff7a1a 100%)',
    );
  });
});
