import { describe, expect, it } from 'vitest';
import { launcherFor, openBrowser } from '../src/browser';

const record = () => {
  const calls: [string, string[]][] = [];
  return { calls, spawner: (c: string, a: string[]) => void calls.push([c, a]) };
};

describe('25.6 openBrowser only launches http(s) URLs', () => {
  it('25.6 launches https and http URLs through the platform opener', () => {
    const r = record();
    expect(
      openBrowser('https://bastion.example/oauth/device?user_code=A', r.spawner, 'linux'),
    ).toBe(true);
    expect(r.calls).toEqual([['xdg-open', ['https://bastion.example/oauth/device?user_code=A']]]);
    expect(openBrowser('http://127.0.0.1:1/x', r.spawner, 'darwin')).toBe(true);
    expect(r.calls[1]?.[0]).toBe('open');
  });

  it('25.6 refuses other schemes and unparsable input', () => {
    const r = record();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/x', 'nope', '']) {
      expect(openBrowser(url, r.spawner, 'win32')).toBe(false);
    }
    expect(r.calls).toEqual([]);
  });

  it('25.6 survives a spawner that throws and picks the Windows launcher', () => {
    expect(
      openBrowser('https://a.test/', () => {
        throw new Error('no opener');
      }),
    ).toBe(false);
    expect(launcherFor('win32', 'https://a.test/')[0]).toBe('rundll32');
  });
});
