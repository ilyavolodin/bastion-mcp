import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { mapUpstreamError } from '../src/errors';

const ctx = { installation: 'n8n' };
const body = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } });
const httpError = (status: number, text: string) =>
  new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
    status,
    text,
  });

describe('6.9 an upstream JSON-RPC error sent with an HTTP error status stays an upstream error', () => {
  it('maps "Method not found" sent with HTTP 404 to the upstream JSON-RPC error -32601', async () => {
    const mapped = await mapUpstreamError(httpError(404, body(-32601, 'Method not found')), ctx);
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.mcpCode).toBe(-32601);
    expect(mapped.message).toBe('Method not found');
  });

  it('does the same for HTTP 400 and for a body carried only in the message', async () => {
    expect((await mapUpstreamError(httpError(400, body(-32602, 'bad')), ctx)).mcpCode).toBe(-32602);
    const bare = new SdkError(
      SdkErrorCode.ClientHttpUnexpectedContent,
      `Error POSTing to endpoint: ${body(-32601, 'Method not found')}`,
    );
    expect((await mapUpstreamError(bare, ctx)).mcpCode).toBe(-32601);
  });

  it('still treats 401 and 403 as a rejected credential, even with a JSON-RPC body', async () => {
    for (const status of [401, 403]) {
      const mapped = await mapUpstreamError(httpError(status, body(-32001, 'nope')), ctx);
      expect(mapped.code).toBe('UPSTREAM_AUTH_REQUIRED');
    }
  });

  it('keeps an HTTP error without a JSON-RPC body as unavailable, naming the status', async () => {
    const mapped = await mapUpstreamError(httpError(502, '<html>Bad gateway</html>'), ctx);
    expect(mapped.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapped.message).toContain('Bad gateway');
  });
});
