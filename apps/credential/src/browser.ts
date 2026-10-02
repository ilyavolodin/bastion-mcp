import { spawn } from 'node:child_process';

/** Opens a verification URL in the default browser. Only http(s) URLs are ever launched. */
export const openBrowser = (url: string): void => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  const target = parsed.toString();
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined); // no browser (headless): the URL is printed anyway
    child.unref();
  } catch {
    // ignore: the user can open the printed URL
  }
};
