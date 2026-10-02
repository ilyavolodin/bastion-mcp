#!/usr/bin/env node
// A stdio JSON-RPC fake MCP server (legacy era, newline-delimited) usable by the sandbox runner (8.3) and
// by tests. Tools: echo, whoami, ask (elicitation/create), ask2 (two parallel elicitations), slow, crash.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let nextId = 1;
let clientInfo;
let capabilities;

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `s${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });

const text = (value) => ({ content: [{ type: 'text', text: value }] });

const tools = [
  { name: 'echo', inputSchema: { type: 'object' } },
  { name: 'whoami', inputSchema: { type: 'object' } },
  { name: 'ask', inputSchema: { type: 'object' } },
  { name: 'ask2', inputSchema: { type: 'object' } },
  { name: 'slow', inputSchema: { type: 'object' } },
  { name: 'crash', inputSchema: { type: 'object' } },
];

const callTool = async (params) => {
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'echo':
      return text(String(args.text ?? ''));
    case 'whoami':
      return text(JSON.stringify({ clientInfo, capabilities, meta: params._meta ?? {} }));
    case 'ask': {
      const out = await request('elicitation/create', {
        message: String(args.q ?? 'name?'),
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
      });
      return text(out.action === 'accept' ? `hello ${out.content?.name}` : `action:${out.action}`);
    }
    case 'ask2': {
      const make = (n) =>
        request('elicitation/create', {
          message: `q${n}`,
          requestedSchema: { type: 'object', properties: { v: { type: 'string' } } },
        });
      const [a, b] = await Promise.all([make(1), make(2)]);
      return text(`${a.content?.v ?? a.action}+${b.content?.v ?? b.action}`);
    }
    case 'slow':
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 100)));
      return text('done');
    case 'crash':
      process.stderr.write('about to crash\n');
      process.exit(3);
      return text('unreachable');
    default:
      throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
  }
};

const handle = async (message) => {
  const { id, method, params } = message;
  try {
    let result;
    switch (method) {
      case 'initialize':
        clientInfo = params.clientInfo;
        capabilities = params.capabilities;
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: 'fake-stdio', version: '1.0.0' },
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools };
        break;
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      case 'tools/call':
        result = await callTool(params);
        break;
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: String(error.message) } });
  }
};

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (waiter) {
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
      else waiter.resolve(message.result);
    }
    return;
  }
  if (message.id === undefined) return;
  void handle(message);
});
