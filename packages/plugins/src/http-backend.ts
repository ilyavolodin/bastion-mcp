import { spawn } from 'node:child_process';

export type HttpBackendRequest = {
  gitBinary?: string;
  /** `GIT_PROJECT_ROOT`. */
  root: string;
  /** Path below the root, `/repo.git/info/refs`. */
  pathInfo: string;
  query: string;
  method: string;
  contentType: string | null;
  contentEncoding: string | null;
  gitProtocol: string | null;
  body: Uint8Array;
  timeoutMs?: number;
};

const HEADER_END = /\r?\n\r?\n/;

/**
 * Runs `git http-backend` as a CGI process and maps its output to a `Response` (25.5). Only
 * `upload-pack` is enabled: `http.receivepack` is forced off and the callers never forward dumb
 * protocol paths.
 */
export const runHttpBackend = (request: HttpBackendRequest): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_PROTOCOL: 'HTTP/1.1',
      GIT_PROJECT_ROOT: request.root,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: request.method,
      PATH_INFO: request.pathInfo,
      QUERY_STRING: request.query,
      CONTENT_LENGTH: String(request.body.byteLength),
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.uploadpack',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'http.receivepack',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_TERMINAL_PROMPT: '0',
    };
    delete env.REMOTE_USER;
    if (request.contentType) env.CONTENT_TYPE = request.contentType;
    if (request.contentEncoding) env.HTTP_CONTENT_ENCODING = request.contentEncoding;
    if (request.gitProtocol) env.HTTP_GIT_PROTOCOL = request.gitProtocol;

    const child = spawn(request.gitBinary ?? 'git', ['http-backend'], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: request.timeoutMs ?? 10 * 60_000,
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        child.kill();
      },
    });
    let pending = Buffer.alloc(0);
    let headersDone = false;

    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.body);
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        controller?.enqueue(new Uint8Array(chunk));
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const match = HEADER_END.exec(pending.toString('latin1'));
      if (!match) return;
      const head = pending.subarray(0, match.index).toString('latin1');
      const rest = pending.subarray(match.index + match[0].length);
      headersDone = true;
      const headers = new Headers();
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers.append(name, value);
      }
      if (rest.length > 0) controller?.enqueue(new Uint8Array(rest));
      resolve(new Response(stream, { status, headers }));
    });
    child.stdout.on('end', () => {
      if (headersDone) controller?.close();
      else reject(new Error('git http-backend produced no response headers'));
    });
    child.on('close', (code) => {
      if (!headersDone) reject(new Error(`git http-backend exited with ${code}`));
    });
  });
