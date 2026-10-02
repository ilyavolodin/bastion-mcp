import type { RuntimeKind } from '@/api/types';

export type ImportedSource = { runtime: RuntimeKind; package: string; version: string; command: string; args: string[]; url: string };

/**
 * Reads a pasted `server.json` remote entry or a client config snippet (11.3):
 * `npx` maps to npm, `uvx` to PyPI; `pkg@1.2.3` carries the version.
 */
export function importSnippet(text: string): ImportedSource | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'Paste valid JSON' };
  }
  if (!json || typeof json !== 'object') return { error: 'Paste a JSON object' };
  const o = json as Record<string, unknown>;
  // Client configs wrap one server in { mcpServers: { name: {...} } }.
  const wrapped = (o.mcpServers ?? o.servers) as Record<string, unknown> | undefined;
  const first = wrapped ? (Object.values(wrapped)[0] as Record<string, unknown> | undefined) : undefined;
  const cfg = first ?? o;
  const url = typeof cfg.url === 'string' ? cfg.url : Array.isArray(cfg.remotes) ? String((cfg.remotes[0] as { url?: string })?.url ?? '') : '';
  if (url) return { runtime: 'remote', package: '', version: '', command: '', args: [], url };
  const command = typeof cfg.command === 'string' ? cfg.command : '';
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  const runtime: RuntimeKind | null = command === 'npx' ? 'npm' : command === 'uvx' ? 'python' : null;
  if (!runtime) return { error: 'Only npx, uvx and remote URLs can be imported' };
  const spec = args.find((a) => !a.startsWith('-'));
  if (!spec) return { error: 'No package found in args' };
  const at = spec.lastIndexOf('@');
  const hasVersion = at > 0;
  return { runtime, package: hasVersion ? spec.slice(0, at) : spec, version: hasVersion ? spec.slice(at + 1) : '', command, args, url: '' };
}
