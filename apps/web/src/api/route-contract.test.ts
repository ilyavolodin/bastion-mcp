import { describe, expect, it } from 'vitest';
import { resetDb } from '@/mocks/db';
import { accessSamples } from '@/mocks/domains/access';
import { catalogSamples } from '@/mocks/domains/catalog';
import { observabilitySamples } from '@/mocks/domains/observability';
import { pluginsSamples } from '@/mocks/domains/plugins';
import { registrySamples } from '@/mocks/domains/registry';
import { serversSamples } from '@/mocks/domains/servers';
import { sessionSamples } from '@/mocks/domains/session';
import { settingsSamples } from '@/mocks/domains/settings';
import { type Sample, type SampleFactory, typedRoutes } from '@/mocks/http';
import { findOperation, hasJsonResponse, validateRequest, validateResponse } from '@/test/contract';
import openapi from '../../../../packages/api-client/openapi.json';

/**
 * Contract between the console and the real API: every route the UI calls, and every route the MSW mock
 * answers, must exist in the OpenAPI document with the same method (17.2). Mock-only routes are a failure.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];
const doc = openapi as unknown as { paths: Record<string, Record<string, unknown>> };

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m] !== undefined).map((method) => ({
    method,
    segments: path.split('/').filter(Boolean),
  })),
);

/** `*` stands for any path parameter or glob in the caller's path. */
const exists = (method: Method, path: string): boolean => {
  const segs = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  return operations.some((op) => {
    if (op.method !== method) return false;
    const last = op.segments.at(-1) === '{path}';
    if (last ? segs.length < op.segments.length : segs.length !== op.segments.length) return false;
    return op.segments.every((s, i) => {
      if (s.startsWith('{')) return true;
      return segs[i] === s || segs[i] === '*';
    });
  });
};

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const toGlob = (template: string): string => template.replace(/\$\{[^}]*\}/g, '*');

const uiCalls = Object.entries(sources)
  .filter(([file]) => !/\.test\.|\/mocks\/|\/test\//.test(file))
  .flatMap(([file, text]) => {
    const calls: { file: string; method: Method; path: string }[] = [];
    for (const m of text.matchAll(
      /\bapi\s*\.\s*(get|post|put|patch|delete)[^(`'"]*\(\s*([`'])(.*?)\2/gs,
    )) {
      calls.push({ file, method: m[1] as Method, path: toGlob(m[3] ?? '') });
    }
    for (const m of text.matchAll(
      /\b(?:listQuery|pagedQuery)(?:<[^(`'"]*>)?\([^,]+,\s*([`'])(.*?)\1/gs,
    )) {
      calls.push({ file, method: 'get', path: toGlob(m[2] ?? '') });
    }
    for (const m of text.matchAll(/\bfetchAll(?:<[^(`'"]*>)?\(\s*([`'])(.*?)\1/gs)) {
      calls.push({ file, method: 'get', path: toGlob(m[2] ?? '') });
    }
    return calls;
  });

describe('console routes exist in the OpenAPI document (17.2)', () => {
  it('finds the calls it is meant to check', () => {
    expect(uiCalls.length).toBeGreaterThan(80);
  });

  it('17.2 every API call of the UI has an operation', () => {
    const missing = uiCalls
      .filter((c) => c.path.startsWith('/') && !exists(c.method, c.path))
      .map((c) => `${c.method.toUpperCase()} ${c.path} (${c.file})`);
    expect(missing).toEqual([]);
  });

  it('17.2 every route the MSW handlers answer has an operation (no mock-only routes)', () => {
    const handlers = sources['/src/mocks/handlers.ts'] ?? '';
    const routes = [
      ...handlers.matchAll(/http\.(get|post|put|patch|delete)\(\s*P\('([^']+)'/g),
    ].map((m) => ({ method: m[1] as Method, path: (m[2] ?? '').replace(/:[A-Za-z]+/g, '*') }));
    // Legacy `http.*(P(...))` handlers plus the typed `route.*` ones (their paths are checked by the compiler).
    expect(routes.length + new Set(typedRoutes.map((r) => r.key)).size).toBeGreaterThan(60);
    const missing = routes
      .filter((r) => !exists(r.method, r.path))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(missing).toEqual([]);
  });
});

// --- the typed mock answers what the OpenAPI document says (17.2) -------------------------------------------------

const DOMAINS: Record<string, SampleFactory> = {
  access: accessSamples,
  settings: settingsSamples,
  catalog: catalogSamples,
  servers: serversSamples,
  observability: observabilitySamples,
  registry: registrySamples,
  plugins: pluginsSamples,
  session: sessionSamples,
};

const callMock = async (sample: Sample): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`/api/v1${sample.path}`, {
    method: sample.method.toUpperCase(),
    headers: { 'content-type': 'application/json', 'x-bastion-csrf': 'test-csrf' },
    ...(sample.body === undefined ? {} : { body: JSON.stringify(sample.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

describe('the MSW mock conforms to the OpenAPI document (17.2)', () => {
  for (const [domain, factory] of Object.entries(DOMAINS)) {
    it(`17.2 ${domain}: every sample request is valid and every response matches its schema`, async () => {
      const samples = factory(resetDb('admin'));
      const problems: string[] = [];
      for (const sample of samples) {
        const op = findOperation(sample.method, sample.path);
        if (!op) {
          problems.push(`${sample.method.toUpperCase()} ${sample.path}: not an API operation`);
          continue;
        }
        if (sample.body !== undefined) {
          const sent = validateRequest(op, sample.body);
          if (!sent.ok)
            problems.push(
              `${sample.method.toUpperCase()} ${op.template} request: ${sent.errors.join('; ')}`,
            );
        }
        resetDb('admin');
        const answer = await callMock(sample);
        if (answer.status >= 400) {
          problems.push(`${sample.method.toUpperCase()} ${sample.path} answered ${answer.status}`);
          continue;
        }
        if (hasJsonResponse(op) && answer.body !== undefined) {
          const verdict = validateResponse(op, answer.body, answer.status);
          if (!verdict.ok)
            problems.push(
              `${sample.method.toUpperCase()} ${op.template} response: ${verdict.errors.slice(0, 5).join('; ')}`,
            );
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('17.2 every route a typed handler answers has a sample request', () => {
    const covered = new Set<string>();
    for (const factory of Object.values(DOMAINS)) {
      for (const sample of factory(resetDb('admin'))) {
        const op = findOperation(sample.method, sample.path);
        if (op) covered.add(`${op.method} ${op.template}`);
      }
    }
    const uncovered = typedRoutes
      .map((r) => `${r.method} ${r.key}`)
      .filter((key, i, all) => all.indexOf(key) === i && !covered.has(key));
    expect(uncovered).toEqual([]);
  });
});
