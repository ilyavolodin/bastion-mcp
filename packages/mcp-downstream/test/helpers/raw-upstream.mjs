#!/usr/bin/env node
// A minimal warm modern upstream in its own process for the proxy-overhead test (23.4): raw JSON-RPC, no per-request
// server construction. Prints its URL on stdout once it listens.
import http from 'node:http';

const info = { name: 'raw', version: '1' };
const meta = { 'io.modelcontextprotocol/serverInfo': info };
const answer = (body) => {
  switch (body.method) {
    case 'server/discover':
      return {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: info,
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: meta,
      };
    case 'tools/list':
      return {
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
        resultType: 'complete',
        ttlMs: 600000,
        cacheScope: 'private',
        _meta: meta,
      };
    case 'tools/call':
      return {
        content: [{ type: 'text', text: String(body.params?.arguments?.text ?? '') }],
        resultType: 'complete',
        _meta: meta,
      };
    default:
      return undefined;
  }
};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = answer(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } }
            : { jsonrpc: '2.0', id: body.id, result },
        ),
      );
    } catch {
      res.writeHead(400).end();
    }
  });
});
server.keepAliveTimeout = 60000;
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/mcp`);
});
