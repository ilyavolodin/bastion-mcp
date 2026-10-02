import { describe, expect, it } from 'vitest';
import { driveLegacyInput } from '../src/bridge/legacy';
import type { OpOutcome } from '../src/types';

const complete = (text: string): OpOutcome<unknown> => ({
  kind: 'complete',
  result: { content: [{ type: 'text', text }] },
});
const needs = (
  inputRequests: Record<string, { method: string; params?: unknown }>,
  requestState = 'bst1.s',
): OpOutcome<unknown> => ({
  kind: 'input_required',
  inputRequests,
  requestState,
  installationId: 'inst-a',
});

const FULL = { elicitation: { form: {} }, sampling: {}, roots: {} };

describe('6.5 legacy fan-out bridge', () => {
  it('6.5 asks the client for each entry, then retries the same params with inputResponses and requestState', async () => {
    const seen: Record<string, unknown>[] = [];
    const asked: string[] = [];
    const result = await driveLegacyInput({
      params: { name: 't', arguments: { a: 1 } },
      caps: FULL,
      roots: async () => [],
      run: async (params) => {
        seen.push(params);
        return seen.length === 1
          ? needs({ name: { method: 'elicitation/create', params: { message: 'm' } } })
          : complete('done');
      },
      ask: async (method) => {
        asked.push(method);
        return { action: 'accept', content: { name: 'Ada' } };
      },
    });
    expect(asked).toEqual(['elicitation/create']);
    expect(seen[1]).toEqual({
      name: 't',
      arguments: { a: 1 },
      inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
      requestState: 'bst1.s',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }] });
  });

  it('6.5 answers missing capabilities itself: decline, -32601 for sampling, configured roots, and the client never sees them', async () => {
    const seen: Record<string, unknown>[] = [];
    let asked = 0;
    await driveLegacyInput({
      params: { name: 't' },
      caps: {},
      roots: async (id) => (id === 'inst-a' ? ['file:///w'] : []),
      run: async (params) => {
        seen.push(params);
        return seen.length === 1
          ? needs({
              e: { method: 'elicitation/create', params: {} },
              s: { method: 'sampling/createMessage', params: {} },
              r: { method: 'roots/list' },
            })
          : complete('ok');
      },
      ask: async () => {
        asked += 1;
        return {};
      },
    });
    expect(asked).toBe(0);
    expect(seen[1]?.inputResponses).toEqual({
      e: { action: 'decline' },
      s: { error: { code: -32601, message: 'client does not support sampling' } },
      r: { roots: [{ uri: 'file:///w' }] },
    });
  });

  it('6.5 caps rounds per original request at 10', async () => {
    let runs = 0;
    await expect(
      driveLegacyInput({
        params: {},
        caps: FULL,
        roots: async () => [],
        run: async () => {
          runs += 1;
          return needs({ k: { method: 'elicitation/create', params: {} } });
        },
        ask: async () => ({ action: 'accept' }),
      }),
    ).rejects.toMatchObject({ mcpCode: -32603, message: 'too many input rounds' });
    expect(runs).toBe(11);
  });

  it('6.5 without a way to ask the client (JSON-only response) every entry is answered by the capability rules', async () => {
    const seen: Record<string, unknown>[] = [];
    await driveLegacyInput({
      params: {},
      caps: FULL,
      roots: async () => [],
      run: async (params) => {
        seen.push(params);
        return seen.length === 1
          ? needs({ k: { method: 'elicitation/create', params: {} } })
          : complete('x');
      },
    });
    expect(seen[1]?.inputResponses).toEqual({ k: { action: 'decline' } });
  });

  it('6.5 a task outcome is not served to legacy clients', async () => {
    await expect(
      driveLegacyInput({
        params: {},
        caps: FULL,
        roots: async () => [],
        run: async () => ({ kind: 'task', task: { taskId: 'x' } }),
      }),
    ).rejects.toMatchObject({ mcpCode: -32601 });
  });
});
