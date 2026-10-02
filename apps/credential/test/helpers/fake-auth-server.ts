import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type TokenScript = (
  form: URLSearchParams,
  call: number,
) => { status: number; body: unknown };

/** A local fake authorization server (`node:http`) at `<origin>/oauth`: discovery, device and token endpoints. */
export const startFakeAuthServer = async (options: {
  token: TokenScript;
  interval?: number;
  expiresIn?: number;
  discovery?: boolean;
  deviceStatus?: number;
}): Promise<{
  url: URL;
  requests: { path: string; form: URLSearchParams }[];
  close: () => Promise<void>;
}> => {
  const requests: { path: string; form: URLSearchParams }[] = [];
  let tokenCalls = 0;
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };
  let origin = '';
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const form = new URLSearchParams(await readBody(req));
    requests.push({ path, form });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/oauth/.well-known/openid-configuration') {
      if (options.discovery === false) return send(404, {});
      return send(200, {
        issuer: `${origin}/oauth`,
        device_authorization_endpoint: `${origin}/oauth/device/auth`,
        token_endpoint: `${origin}/oauth/token`,
      });
    }
    if (path === '/oauth/device/auth') {
      if (options.deviceStatus && options.deviceStatus !== 200) {
        return send(options.deviceStatus, { error: 'invalid_client' });
      }
      return send(200, {
        device_code: 'DEVICE-CODE',
        user_code: 'ABCD-EFGH',
        verification_uri: `${origin}/oauth/device`,
        verification_uri_complete: `${origin}/oauth/device?user_code=ABCD-EFGH`,
        expires_in: options.expiresIn ?? 600,
        interval: options.interval ?? 5,
      });
    }
    if (path === '/oauth/token') {
      tokenCalls += 1;
      const result = options.token(form, tokenCalls);
      return send(result.status, result.body);
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: new URL(origin),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
