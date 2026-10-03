import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const mutate = vi.fn();
let pending = false;

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/api/hooks', () => ({
  useConnectInstallation: () => ({ mutate, isPending: pending }),
}));

const { openAuthorization, useInstallationAction } = await import('./use-installation-action');

const inst = (status: string, authMode = 'oauth') =>
  ({ id: 'i1', displayName: 'GitHub', status, authMode }) as never;

describe('useInstallationAction (18.1)', () => {
  beforeEach(() => {
    navigate.mockReset();
    mutate.mockReset();
    pending = false;
  });
  afterEach(() => vi.restoreAllMocks());

  it('does nothing for an installation that is ready', () => {
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('ready'));
    expect(mutate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('starts the sign-in of an OAuth installation that needs setup, and returns to its connection tab', () => {
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('needs_setup', 'oauth'));
    expect(mutate).toHaveBeenCalledWith(
      { id: 'i1', returnTo: '/servers/i1?tab=connection' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('starts the sign-in again when the connection has to be renewed', () => {
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('reconnect_required'));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('opens the authorization URL it is given in its own tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('needs_setup'));
    const options = mutate.mock.calls[0]?.[1] as {
      onSuccess: (r: { authorizationUrl: string }) => void;
    };
    options.onSuccess({ authorizationUrl: 'https://auth.example/authorize?x=1' });
    expect(open).toHaveBeenCalledWith(
      'https://auth.example/authorize?x=1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('takes a person without a key to the connection tab to add one', () => {
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('needs_setup', 'userSecret'));
    expect(mutate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/servers/i1', search: { tab: 'connection' } });
  });

  it('takes a failing installation to its logs', () => {
    const { result } = renderHook(() => useInstallationAction());
    result.current.run(inst('error'));
    expect(navigate).toHaveBeenCalledWith({ to: '/servers/i1', search: { tab: 'logs' } });
  });

  it('says when the sign-in is being started', () => {
    pending = true;
    const { result } = renderHook(() => useInstallationAction());
    expect(result.current.pending).toBe(true);
  });

  it('openAuthorization opens without giving the page to the opened tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openAuthorization('https://x.example');
    expect(open).toHaveBeenCalledWith('https://x.example', '_blank', 'noopener,noreferrer');
  });
});
