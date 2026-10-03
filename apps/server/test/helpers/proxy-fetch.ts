/**
 * The server's public URL is `https://bastion.test` (the OAuth issuer must be https) while the test listener speaks
 * plain HTTP on 127.0.0.1. `proxyFetch` plays the TLS-terminating proxy: it rewrites requests for the public origin
 * to the listener and adds `x-forwarded-proto: https` / `x-forwarded-host`. `Browser` adds a cookie jar and
 * redirect handling on top, so OIDC and OAuth flows can be driven like a user agent would.
 */

import { PUBLIC_URL } from './constants';

export { PUBLIC_URL };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A `fetch` that routes `https://bastion.test/*` to `http://127.0.0.1:<port>/*` (any other URL goes straight out). */
export const proxyFetch = (port: number, publicUrl = PUBLIC_URL): FetchLike => {
  const publicOrigin = new URL(publicUrl);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== publicOrigin.origin) return fetch(request);
    const target = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', publicOrigin.host);
    headers.set('host', publicOrigin.host);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const forwarded = new Request(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: request.signal,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    });
    return fetch(forwarded);
  };
};

/** Cookie jar keyed by host; enough for `bastion_sid`, `bastion_csrf` and oidc-provider cookies. */
export class CookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  store(url: string, response: Response): void {
    const host = new URL(url).host;
    const jar = this.cookies.get(host) ?? new Map<string, string>();
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    this.cookies.set(host, jar);
  }

  header(url: string): string | undefined {
    const jar = this.cookies.get(new URL(url).host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(url: string, name: string): string | undefined {
    return this.cookies.get(new URL(url).host)?.get(name);
  }
}

export type BrowserResponse = {
  status: number;
  headers: Headers;
  url: string;
  text: string;
  location: string | null;
};

/** A tiny user agent: cookies, manual redirect following that stops at non-public origins (native client callbacks). */
export class Browser {
  readonly jar = new CookieJar();
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly publicUrl = PUBLIC_URL,
  ) {}

  /** One request, no redirect following. */
  async request(url: string, init: RequestInit = {}): Promise<BrowserResponse> {
    const headers = new Headers(init.headers);
    const cookie = this.jar.header(url);
    if (cookie) headers.set('cookie', cookie);
    const response = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
    this.jar.store(url, response);
    const location = response.headers.get('location');
    return {
      status: response.status,
      headers: response.headers,
      url,
      text: await response.text(),
      location: location ? new URL(location, url).href : null,
    };
  }

  /** Follows redirects while they stay on the public origin; returns the first response that does not. */
  async navigate(url: string, init: RequestInit = {}, max = 15): Promise<BrowserResponse> {
    let current = url;
    let nextInit = init;
    for (let i = 0; i < max; i++) {
      const res = await this.request(current, nextInit);
      if (res.status < 300 || res.status >= 400 || !res.location) return res;
      if (new URL(res.location).origin !== new URL(this.publicUrl).origin) return res;
      current = res.location;
      nextInit = res.status === 307 || res.status === 308 ? nextInit : {};
    }
    throw new Error(`too many redirects from ${url}`);
  }

  /** Posts a form (application/x-www-form-urlencoded). */
  post(url: string, form: Record<string, string>, headers: Record<string, string> = {}) {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }
}
