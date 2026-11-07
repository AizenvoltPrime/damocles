import { describe, expect, it, vi } from 'vitest';
import type { BrowserToolAnswer } from '../../../../shared/remote-user';
import { interceptPattern, relayBrowserTool, typedRemoteAddress, type BrowserRelayDeps } from '../browser-relay';
import { PARITY_CAPTURE_TOOL } from '../../../../core/design/parity-capture';

function relay(overrides: Partial<BrowserRelayDeps> = {}) {
  const forwards: Array<{ host: string; port: number }> = [];
  const tunnels = [{ localPort: 5174, remote: { host: '127.0.0.1', port: 5173 } }];
  const run = vi.fn(async (params: Parameters<BrowserRelayDeps['run']>[0]): Promise<BrowserToolAnswer> => ({
    content: [{ type: 'text', text: `Navigated to: ${(params.input as { url?: string }).url ?? ''}\n[URL] http://localhost:5174/app ws://127.0.0.1:5174/hmr` }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }],
  }));
  const attached: string[] = [];
  const deps: BrowserRelayDeps = {
    authority: 'ssh+host-1',
    attachView: async (viewId) => void attached.push(viewId),
    tunnels: () => ({
      list: () => tunnels,
      forward: async (_authority, remote) => {
        forwards.push(remote);
        return tunnels[0]!;
      },
    }),
    policy: () => ({ allowedPorts: [5174], allowLocalNetwork: false }),
    run,
    ...overrides,
  };
  return { deps, run, forwards, attached };
}

const request = (tool: string, input: unknown) => ({ viewId: 'view-1', scope: 'chat', tool, input });

describe('a remote chat\'s browser tool on this computer', () => {
  it('opens the target\'s loopback address on its forward and answers in the target\'s form', async () => {
    const { deps, run, attached } = relay();
    const answer = await relayBrowserTool(deps, request('BrowserNavigate', { url: 'http://localhost:5173/app' }), new AbortController().signal);
    expect(run).toHaveBeenCalledWith({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserNavigate', input: { url: 'http://localhost:5174/app' } }, expect.any(AbortSignal));
    expect(attached).toEqual(['view-1']);
    expect(answer.content[0]).toEqual({ type: 'text', text: 'Navigated to: http://localhost:5173/app\n[URL] http://localhost:5173/app ws://127.0.0.1:5173/hmr' });
    expect(answer.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  });

  it('refuses an address on this computer\'s network with the guard\'s reason, and runs nothing', async () => {
    const { deps, run } = relay();
    const answer = await relayBrowserTool(deps, request('BrowserOpen', { url: 'http://10.0.0.5:8080/' }), new AbortController().signal);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]).toMatchObject({ type: 'text' });
    expect(run).not.toHaveBeenCalled();
  });

  it("moves DesignParity's capture address to its forward and guards it as an open", async () => {
    const { deps, run } = relay();
    await relayBrowserTool(deps, { viewId: 'view-1', scope: 'design-parity-1', tool: PARITY_CAPTURE_TOOL, input: { url: 'http://localhost:5173/contacts', width: 768 } }, new AbortController().signal);
    expect(run).toHaveBeenCalledWith({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'design-parity-1', tool: PARITY_CAPTURE_TOOL, input: { url: 'http://localhost:5174/contacts', width: 768 } }, expect.any(AbortSignal));
    run.mockClear();
    const refused = await relayBrowserTool(deps, { viewId: 'view-1', scope: 'design-parity-1', tool: PARITY_CAPTURE_TOOL, input: { url: 'http://10.0.0.5:8080/', width: 768 } }, new AbortController().signal);
    expect(refused.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a file address the agent names', async () => {
    const { deps, run } = relay();
    const answer = await relayBrowserTool(deps, request('BrowserTabs', { action: 'new', url: 'file:///C:/Users/me/.ssh/id_ed25519' }), new AbortController().signal);
    expect(answer.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses BrowserUpload, whose paths name files on the host', async () => {
    const { deps, run } = relay();
    const answer = await relayBrowserTool(deps, request('BrowserUpload', { paths: ['/srv/app/a.png'] }), new AbortController().signal);
    expect(answer).toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a call for a view this computer does not show before it forwards anything', async () => {
    const { deps, run, forwards } = relay({ attachView: async () => { throw new Error('No chat of this host shows that view'); } });
    await expect(relayBrowserTool(deps, request('BrowserNavigate', { url: 'http://localhost:3000/' }), new AbortController().signal)).rejects.toThrow('No chat of this host shows that view');
    expect(forwards).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a typed address already on a forward\'s local port on that forward, and moves a target address to its forward', async () => {
    const { deps, forwards } = relay();
    expect(await typedRemoteAddress('http://localhost:5174/again', 'ssh+host-1', deps.tunnels(), deps.policy)).toEqual({ allowed: true, url: 'http://localhost:5174/again' });
    // an address in the query (an OAuth redirect) stays exactly as typed
    expect(await typedRemoteAddress('http://localhost:5174/?next=http://localhost:5174/cb', 'ssh+host-1', deps.tunnels(), deps.policy)).toEqual({ allowed: true, url: 'http://localhost:5174/?next=http://localhost:5174/cb' });
    expect(await typedRemoteAddress('http://localhost:5173/app', 'ssh+host-1', deps.tunnels(), deps.policy)).toEqual({ allowed: true, url: 'http://localhost:5174/app' });
    expect(forwards).toEqual([]);
    expect(await typedRemoteAddress('http://10.0.0.5/', 'ssh+host-1', deps.tunnels(), deps.policy)).toMatchObject({ allowed: false });
  });

  it('moves an intercept pattern\'s concrete target loopback origin to its forward, leaves every other pattern, and answers rules in the target\'s form', async () => {
    const { deps, run } = relay();
    const tunnels = deps.tunnels();
    expect(await interceptPattern('http://localhost:5173/api/**', 'ssh+host-1', tunnels)).toBe('http://localhost:5174/api/**');
    expect(await interceptPattern('http://127.0.0.1:5173/**/*.png', 'ssh+host-1', tunnels)).toBe('http://127.0.0.1:5174/**/*.png');
    for (const untouched of ['**/*.png', 'https://api.example.com/**', 'http://localhost:*/api', 'http://*.localhost:5173/**', '/^https?:\\/\\/localhost:5173\\//', 'http://user@example.com/**', 'http://localhost:5173@evil.com/x', 'http://x@localhost:5173/**', 'http://Example.COM/**', 'HTTP://Example.COM/**']) {
      expect(await interceptPattern(untouched, 'ssh+host-1', tunnels), untouched).toBe(untouched);
    }
    run.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Added rule r1: block http://localhost:5174/api/**' }] });
    const answer = await relayBrowserTool(deps, request('BrowserIntercept', { action: 'add', pattern: 'http://localhost:5173/api/**', type: 'block' }), new AbortController().signal);
    expect(run.mock.calls.at(-1)?.[0].input).toEqual({ action: 'add', pattern: 'http://localhost:5174/api/**', type: 'block' });
    expect(answer.content[0]).toEqual({ type: 'text', text: 'Added rule r1: block http://localhost:5173/api/**' });
  });

  it('passes a tool without an address as it came', async () => {
    const { deps, run } = relay();
    await relayBrowserTool(deps, request('BrowserClick', { ref: 'e3' }), new AbortController().signal);
    expect(run.mock.calls[0]?.[0].input).toEqual({ ref: 'e3' });
  });
});
