#!/usr/bin/env node
// Open-loop load generator for the proxy-overhead test (23.4), run in its own process so it does not compete with
// the gateway for the event loop. Requests are scheduled at a fixed rate; latency is measured from the SCHEDULED time
// (no coordinated omission). Usage: node loadgen.mjs <url> <rps> <seconds> <warmupSeconds> [token]
import http from 'node:http';

const [url, rpsArg, secondsArg, warmupArg, token] = process.argv.slice(2);
const rps = Number(rpsArg);
const seconds = Number(secondsArg);
const warmup = Number(warmupArg);
const target = new URL(url);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'loadgen', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const body = (id) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'ping' }, _meta: envelope },
  });

const send = (id) =>
  new Promise((resolve) => {
    const payload = body(id);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'echo',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(res.statusCode === 200 && parsed.result && !parsed.error);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.end(payload);
  });

const samples = [];
let errors = 0;
let pending = 0;
const interval = 1000 / rps;
const start = process.hrtime.bigint();
const nowMs = () => Number(process.hrtime.bigint() - start) / 1e6;
const total = Math.floor((seconds + warmup) * rps);
const warmupCount = Math.floor(warmup * rps);

const done = new Promise((resolve) => {
  let issued = 0;
  const tick = () => {
    const due = nowMs();
    while (issued < total && issued * interval <= due) {
      const scheduled = issued * interval;
      const index = issued;
      issued += 1;
      pending += 1;
      send(index).then((ok) => {
        pending -= 1;
        if (index >= warmupCount) {
          if (ok) samples.push(nowMs() - scheduled);
          else errors += 1;
        }
        if (issued >= total && pending === 0) resolve();
      });
    }
    if (issued < total) setImmediate(tick);
  };
  tick();
});
await done;
samples.sort((a, b) => a - b);
const pct = (p) =>
  samples[Math.min(samples.length - 1, Math.max(0, Math.ceil((p / 100) * samples.length) - 1))];
console.log(
  JSON.stringify({
    count: samples.length,
    errors,
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    max: samples.at(-1),
    mean: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
  }),
);
agent.destroy();
process.exit(0);
