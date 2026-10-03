import { spawn } from 'node:child_process';

export type Spawner = (command: string, args: string[]) => void;

/** The launcher command for a platform; the URL is always passed as an argument, never through a shell. */
export const launcherFor = (platform: string, target: string): [string, string[]] =>
  platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
    : platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];

const spawnDetached: Spawner = (command, args) => {
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined); // no browser (headless): the URL is printed anyway
  child.unref();
};

/** Opens a verification URL in the default browser. Only http(s) URLs are ever launched. */
export const openBrowser = (
  url: string,
  spawner: Spawner = spawnDetached,
  platform: string = process.platform,
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const [command, args] = launcherFor(platform, parsed.toString());
  try {
    spawner(command, args);
    return true;
  } catch {
    return false; // the user can open the printed URL
  }
};
