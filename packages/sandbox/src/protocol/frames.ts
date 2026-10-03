/**
 * Runner stdio WebSocket frames (8.3). JSON text frames, one per WebSocket message:
 *
 *   worker -> runner   {"t":"m","d":<JSON-RPC message>}
 *   runner -> worker   {"t":"m","d":<JSON-RPC message>}
 *   runner -> worker   {"t":"e","d":"<stderr line, max 8 KiB>"}
 *   runner -> worker   {"t":"x","code":<exit code or null>,"signal":<name or null>}
 *
 * Pure module shared by the runner and `RunnerClient`; it never throws on untrusted input.
 */

import { HEADERS } from '@bastion-mcp/core';

export const STDIO_SUBPROTOCOL = 'bastion.stdio.v1';
/** WebSocket close code sent to a connection replaced by a newer one (8.3, 21.2). */
export const CLOSE_CODE_REPLACED = 4001;
export const MAX_STDERR_LINE_BYTES = 8 * 1024;
/** Hard cap for one frame; matches the upstream message cap (6.4) plus envelope room. */
export const MAX_FRAME_BYTES = 33 * 1024 * 1024;
/** Response header on the WebSocket upgrade that reports messages dropped while disconnected. */
export const DROPPED_HEADER = HEADERS.dropped;

export type JsonObject = { [key: string]: unknown };

export type Frame =
  | { t: 'm'; d: JsonObject }
  | { t: 'e'; d: string }
  | { t: 'x'; code: number | null; signal: string | null };

export type DecodeResult = { ok: true; frame: Frame } | { ok: false; reason: string };

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON-RPC 2.0 message shape check (not full validation; the SDK validates the content). */
export const isJsonRpcMessage = (value: unknown): value is JsonObject =>
  isJsonObject(value) && value.jsonrpc === '2.0';

const encoder = new TextEncoder();

/** Truncates to at most `maxBytes` of UTF-8 without splitting a code point. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return '';
  if (text.length * 3 <= maxBytes || encoder.encode(text).length <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > maxBytes) end -= 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not leave a lone high surrogate
  return text.slice(0, end);
};

export const messageFrame = (message: JsonObject): string => JSON.stringify({ t: 'm', d: message });
export const stderrFrame = (line: string): string =>
  JSON.stringify({ t: 'e', d: truncateUtf8(line, MAX_STDERR_LINE_BYTES) });
export const exitFrame = (code: number | null, signal: string | null): string =>
  JSON.stringify({ t: 'x', code, signal });

export const encodeFrame = (frame: Frame): string => {
  switch (frame.t) {
    case 'm':
      return messageFrame(frame.d);
    case 'e':
      return stderrFrame(frame.d);
    case 'x':
      return exitFrame(frame.code, frame.signal);
  }
};

const fail = (reason: string): DecodeResult => ({ ok: false, reason });

/** Parses one frame. `direction` limits the types a peer may send: workers only send `m`. */
export const decodeFrame = (
  raw: string | Uint8Array,
  direction: 'toRunner' | 'toWorker' = 'toWorker',
): DecodeResult => {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.length > MAX_FRAME_BYTES) return fail('frame too large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('frame is not JSON');
  }
  if (!isJsonObject(value)) return fail('frame is not an object');
  const t = value.t;
  if (direction === 'toRunner' && t !== 'm') return fail(`frame type "${String(t)}" not allowed`);
  if (t === 'm') {
    return isJsonRpcMessage(value.d) ? { ok: true, frame: { t, d: value.d } } : fail('bad message');
  }
  if (t === 'e') {
    return typeof value.d === 'string'
      ? { ok: true, frame: { t, d: truncateUtf8(value.d, MAX_STDERR_LINE_BYTES) } }
      : fail('bad stderr line');
  }
  if (t === 'x') {
    const { code, signal } = value;
    const codeOk = code === null || (typeof code === 'number' && Number.isInteger(code));
    const signalOk = signal === null || typeof signal === 'string';
    return codeOk && signalOk
      ? { ok: true, frame: { t, code: code as number | null, signal: signal as string | null } }
      : fail('bad exit frame');
  }
  return fail('unknown frame type');
};
