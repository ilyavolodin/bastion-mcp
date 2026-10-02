import { fileURLToPath } from 'node:url';

/** Absolute path of the stdio JSON-RPC fake MCP server script (run it with `node`). */
export const fakeStdioServerPath: string = fileURLToPath(
  new URL('./stdio-server.mjs', import.meta.url),
);
