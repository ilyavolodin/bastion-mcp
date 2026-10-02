// Tiny fake stdio MCP server: line-delimited JSON-RPC echo used by the runner integration tests.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

process.on('SIGTERM', () => {
  if (process.env.IGNORE_SIGTERM === '1') return;
  process.exit(0);
});

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`bad input: ${line}\n`);
    return;
  }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'env':
      send({ jsonrpc: '2.0', id: msg.id, result: { env: process.env, cwd: process.cwd() } });
      break;
    case 'noise':
      process.stdout.write('this is not json\n');
      send({ jsonrpc: '2.0', id: msg.id, result: { noisy: true } });
      break;
    case 'warn':
      process.stderr.write('warning from server\n');
      send({ jsonrpc: '2.0', id: msg.id, result: { warned: true } });
      break;
    case 'flood': {
      const n = Number(msg.params?.count ?? 0);
      for (let i = 0; i < n; i += 1)
        send({ jsonrpc: '2.0', method: 'notifications/flood', params: { i } });
      send({ jsonrpc: '2.0', id: msg.id, result: { flooded: n } });
      break;
    }
    case 'exit':
      process.exit(3);
      break;
    default:
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { echo: msg.params ?? null, method: msg.method },
      });
  }
});
