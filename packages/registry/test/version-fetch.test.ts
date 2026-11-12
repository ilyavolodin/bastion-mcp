import { describe, expect, it } from 'vitest';
import {
  createNpmVersionResolver,
  createPypiVersionResolver,
  createVersionResolver,
  RegistryInvalidResponseError,
  RegistryMappingError,
  RegistryUnavailableError,
} from '../src';

type Call = { url: string; init: RequestInit | undefined };

const recording = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return respond();
  };
  return { calls, fetch };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** A fetch that never answers until the request signal aborts. */
const hanging = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

describe('11.3 version resolver request plumbing (characterization)', () => {
  it('npm sends the npm accept header, refuses redirects and passes an abort signal', async () => {
    const { calls, fetch } = recording(() => json({ 'dist-tags': { latest: '1.2.3' } }));
    const npm = createNpmVersionResolver('https://npm.example/', { fetch });
    await expect(npm.latest('npm', '@scope/pkg')).resolves.toBe('1.2.3');
    expect(calls[0]?.url).toBe('https://npm.example/@scope%2Fpkg');
    expect(calls[0]?.init?.headers).toEqual({
      accept: 'application/vnd.npm.install-v1+json, application/json',
    });
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('PyPI sends the plain json accept header and the lower-cased json url', async () => {
    const { calls, fetch } = recording(() => json({ info: { version: '0.1.0' } }));
    const pypi = createPypiVersionResolver('https://pypi.example/simple/', { fetch });
    await expect(pypi.latest('pypi', 'Some-Pkg')).resolves.toBe('0.1.0');
    expect(calls[0]?.url).toBe('https://pypi.example/pypi/some-pkg/json');
    expect(calls[0]?.init?.headers).toEqual({ accept: 'application/json' });
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  it('maps 404 to a mapping error and other non-OK statuses to unavailable', async () => {
    const notFound = createNpmVersionResolver('https://npm.example', {
      fetch: recording(() => json({}, 404)).fetch,
    });
    await expect(notFound.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryMappingError);
    await expect(notFound.latest('npm', 'x')).rejects.toThrow('package was not found');
    const down = createPypiVersionResolver('https://pypi.example', {
      fetch: recording(() => json({}, 503)).fetch,
    });
    await expect(down.latest('pypi', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(down.latest('pypi', 'x')).rejects.toThrow('package registry answered HTTP 503');
  });

  it('a transport failure is unavailable with the original error as cause', async () => {
    const boom = new Error('net down');
    const npm = createNpmVersionResolver('https://npm.example', {
      fetch: async () => {
        throw boom;
      },
    });
    const error = await npm.latest('npm', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryUnavailableError);
    expect((error as RegistryUnavailableError).cause).toBe(boom);
  });

  it('pinned: invalid package-index JSON is reported as RegistryUnavailableError (both resolvers)', async () => {
    const bad = recording(() => new Response('not json', { status: 200 }));
    const npm = createNpmVersionResolver('https://npm.example', { fetch: bad.fetch });
    const pypi = createPypiVersionResolver('https://pypi.example', { fetch: bad.fetch });
    await expect(npm.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(pypi.latest('pypi', 'x')).rejects.toThrow(
      'package registry answered invalid JSON',
    );
  });

  it('the body cap applies to both resolvers and reports an invalid response', async () => {
    const big = recording(() => new Response(`{"pad":"${'x'.repeat(500)}"}`, { status: 200 }));
    const npm = createNpmVersionResolver('https://npm.example', {
      fetch: big.fetch,
      maxBodyBytes: 100,
    });
    const pypi = createPypiVersionResolver('https://pypi.example', {
      fetch: big.fetch,
      maxBodyBytes: 100,
    });
    await expect(npm.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryInvalidResponseError);
    await expect(pypi.latest('pypi', 'x')).rejects.toBeInstanceOf(RegistryInvalidResponseError);
  });

  it('timeoutMs aborts a hanging request as unavailable (both resolvers)', async () => {
    const npm = createNpmVersionResolver('https://npm.example', { fetch: hanging, timeoutMs: 20 });
    const pypi = createPypiVersionResolver('https://pypi.example', {
      fetch: hanging,
      timeoutMs: 20,
    });
    await expect(npm.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(pypi.latest('pypi', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('a timeoutMs of 0 given directly to a resolver aborts at once (?? keeps 0)', async () => {
    const npm = createNpmVersionResolver('https://npm.example', { fetch: hanging, timeoutMs: 0 });
    await expect(npm.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('the caller signal aborts the request', async () => {
    const controller = new AbortController();
    const npm = createNpmVersionResolver('https://npm.example', { fetch: hanging });
    const pending = npm.latest('npm', 'x', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('11.3 createVersionResolver forwards an explicit timeoutMs of 0 (aborts at once)', async () => {
    const combined = createVersionResolver({
      npmRegistry: 'https://npm.example',
      pypiIndexUrl: 'https://pypi.example',
      fetch: async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (init?.signal?.aborted) throw new Error('aborted');
        return json({ 'dist-tags': { latest: '2.0.0' } });
      },
      timeoutMs: 0,
    });
    await expect(combined.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('createVersionResolver forwards a positive timeoutMs and its fetch to both resolvers', async () => {
    const combined = createVersionResolver({
      npmRegistry: 'https://npm.example',
      pypiIndexUrl: 'https://pypi.example',
      fetch: hanging,
      timeoutMs: 20,
    });
    await expect(combined.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(combined.latest('pypi', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });
});
