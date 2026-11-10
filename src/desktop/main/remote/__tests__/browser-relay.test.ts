import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

import type { BrowserToolAnswer } from '../../../../shared/remote-user';
import { interceptPattern, relayBrowserTool, typedRemoteAddress, type BrowserRelayDeps } from '../browser-relay';
import { PARITY_CAPTURE_TOOL } from '../../../../core/design/parity-capture';
import type { ServedGrant } from '../../html-preview/served-roots';

// a served root's local port, equal to the target port 51234 a forward moved to 51235
const SERVED_PORT = 51234;

function relay(overrides: Partial<BrowserRelayDeps> = {}) {
  const forwards: Array<{ host: string; port: number }> = [];
  const tunnels = [{ localPort: 5174, remote: { host: '127.0.0.1', port: 5173 } }];
  const run = vi.fn(async (params: Parameters<BrowserRelayDeps['run']>[0]): Promise<BrowserToolAnswer> => ({
    content: [{ type: 'text', text: `Navigated to: ${(params.input as { url?: string }).url ?? ''}\n[URL] http://localhost:5174/app ws://127.0.0.1:5174/hmr` }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }],
  }));
  const attached: string[] = [];
  const grant = vi.fn(async (_request: Parameters<BrowserRelayDeps['served']['grant']>[0]): Promise<ServedGrant | { readonly refused: string; readonly unavailable?: boolean }> => ({
    origin: `http://127.0.0.1:${SERVED_PORT}`,
    open: (relPath: string) => `http://127.0.0.1:${SERVED_PORT}/__damocles_preview/open?${new URLSearchParams({ t: 'TOKEN', p: relPath }).toString()}`,
  }));
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
    policy: () => ({ allowedPorts: [5174, SERVED_PORT], allowLocalNetwork: false }),
    served: { grant, mappings: () => [{ origin: `http://127.0.0.1:${SERVED_PORT}`, displayRoot: '/home/u/proj' }] },
    run,
    ...overrides,
  };
  return { deps, run, forwards, attached, grant };
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
    expect(await typedRemoteAddress('http://localhost:5174/again', 'ssh+host-1', deps.tunnels(), deps.policy, [])).toEqual({ allowed: true, url: 'http://localhost:5174/again' });
    // an address in the query (an OAuth redirect) stays exactly as typed
    expect(await typedRemoteAddress('http://localhost:5174/?next=http://localhost:5174/cb', 'ssh+host-1', deps.tunnels(), deps.policy, [])).toEqual({ allowed: true, url: 'http://localhost:5174/?next=http://localhost:5174/cb' });
    expect(await typedRemoteAddress('http://localhost:5173/app', 'ssh+host-1', deps.tunnels(), deps.policy, [])).toEqual({ allowed: true, url: 'http://localhost:5174/app' });
    expect(forwards).toEqual([]);
    expect(await typedRemoteAddress('http://10.0.0.5/', 'ssh+host-1', deps.tunnels(), deps.policy, [])).toMatchObject({ allowed: false });
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

  it('opens a root file the remote core resolved on its served root, and answers with its file:// address', async () => {
    const { deps, run, grant } = relay();
    run.mockImplementationOnce(async (params) => ({ content: [{ type: 'text', text: `Opened browser: ${(params.input as { url: string }).url}\n[URL] http://127.0.0.1:${SERVED_PORT}/docs/index.html\nconsole: http://localhost:${SERVED_PORT}/docs/app.js:3` }] }));
    const answer = await relayBrowserTool(deps, { ...request('BrowserOpen', { url: 'file:///home/u/proj/docs/index.html' }), served: { kind: 'project', relPath: 'docs/index.html', displayRoot: '/home/u/proj' } }, new AbortController().signal);
    expect(grant).toHaveBeenCalledWith({ root: { kind: 'project' }, viewId: 'view-1', displayRoot: '/home/u/proj' });
    expect(run.mock.calls[0]?.[0].input).toEqual({ url: `http://127.0.0.1:${SERVED_PORT}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html` });
    const text = (answer.content[0] as { text: string }).text;
    expect(text).toBe('Opened browser: file:///home/u/proj/docs/index.html\n[URL] file:///home/u/proj/docs/index.html\nconsole: file:///home/u/proj/docs/app.js:3');
    expect(text).not.toMatch(/TOKEN|127\.0\.0\.1|localhost/);
  });

  it('carries the address\'s query into the one-time open and its fragment onto it, and answers with both in file:// form', async () => {
    const { deps, run } = relay();
    run.mockImplementationOnce(async (params) => ({ content: [{ type: 'text', text: `Opened browser: ${(params.input as { url: string }).url}\n[URL] http://127.0.0.1:${SERVED_PORT}/docs/index.html?tab=2&q=a%20b#intro` }] }));
    const answer = await relayBrowserTool(deps, { ...request('BrowserOpen', { url: 'file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro' }), served: { kind: 'project', relPath: 'docs/index.html', displayRoot: '/home/u/proj' } }, new AbortController().signal);
    const opened = new URL((run.mock.calls[0]?.[0].input as { url: string }).url);
    expect(opened.searchParams.get('p')).toBe('docs/index.html');
    expect(opened.searchParams.get('q')).toBe('tab=2&q=a%20b');
    expect(opened.hash).toBe('#intro');
    const text = (answer.content[0] as { text: string }).text;
    expect(text).toBe('Opened browser: file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro\n[URL] file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro');
    expect(text).not.toMatch(/TOKEN|127\.0\.0\.1/);
  });

  it('refuses a served file whose port the policy lacks without naming the port', async () => {
    const { deps, run } = relay({ policy: () => ({ allowedPorts: [], allowLocalNetwork: false }) });
    const answer = await relayBrowserTool(deps, { ...request('BrowserOpen', { url: 'file:///home/u/proj/a.html' }), served: { kind: 'project', relPath: 'a.html', displayRoot: '/home/u/proj' } }, new AbortController().signal);
    expect(answer).toMatchObject({ isError: true });
    expect((answer.content[0] as { text: string }).text).not.toContain(String(SERVED_PORT));
    expect(run).not.toHaveBeenCalled();
  });

  it('serves a design root file with its design id', async () => {
    const { deps, grant } = relay();
    await relayBrowserTool(deps, { ...request('BrowserNavigate', { url: 'file:///home/u/.damocles/designs/d1/screens/S2.html' }), served: { kind: 'design', designId: 'd1', relPath: 'screens/S2.html', displayRoot: '/home/u/.damocles/designs/d1' } }, new AbortController().signal);
    expect(grant).toHaveBeenCalledWith({ root: { kind: 'design', designId: 'd1' }, viewId: 'view-1', displayRoot: '/home/u/.damocles/designs/d1' });
  });

  it('refuses a served dot file, key or 8.3 alias with a reason, a refused grant, and served on another tool, running nothing', async () => {
    const { deps, run, grant } = relay();
    for (const relPath of ['.env', 'keys/id_rsa', 'GIT~1/config']) {
      const answer = await relayBrowserTool(deps, { ...request('BrowserOpen', { url: `file:///home/u/proj/${relPath}` }), served: { kind: 'project', relPath, displayRoot: '/home/u/proj' } }, new AbortController().signal);
      expect(answer, relPath).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('is not opened') }] });
    }
    expect(grant).not.toHaveBeenCalled();
    // a remote chat's file never opens from this computer's disk, even when no root here serves it
    grant.mockResolvedValueOnce({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.', unavailable: true });
    expect(await relayBrowserTool(deps, { ...request('BrowserOpen', { url: 'file:///home/u/proj/a.html' }), served: { kind: 'project', relPath: 'a.html', displayRoot: '/home/u/proj' } }, new AbortController().signal)).toEqual({ isError: true, content: [{ type: 'text', text: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' }] });
    expect(await relayBrowserTool(deps, { ...request('BrowserClick', { ref: 'e1' }), served: { kind: 'project', relPath: 'a.html', displayRoot: '/home/u/proj' } }, new AbortController().signal)).toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('moves an agent-written loopback address to its target forward even when its port is a served root\'s', async () => {
    const forwarded = { localPort: 51235, remote: { host: 'localhost', port: SERVED_PORT } };
    const { deps, run } = relay({
      tunnels: () => ({ list: () => [forwarded], forward: async () => forwarded }),
      policy: () => ({ allowedPorts: [51235, SERVED_PORT], allowLocalNetwork: false }),
    });
    run.mockImplementationOnce(async () => ({ content: [{ type: 'text', text: `Navigated to: http://localhost:51235/ next to http://127.0.0.1:${SERVED_PORT}/docs/a.html` }] }));
    const answer = await relayBrowserTool(deps, request('BrowserNavigate', { url: `http://localhost:${SERVED_PORT}/` }), new AbortController().signal);
    expect(run.mock.calls[0]?.[0].input).toEqual({ url: 'http://localhost:51235/' });
    // the forward shows its target port and the served page its file, though the two ports are the same number
    expect(answer.content[0]).toEqual({ type: 'text', text: `Navigated to: http://localhost:${SERVED_PORT}/ next to file:///home/u/proj/docs/a.html` });
  });

  it('keeps a typed address on a served root\'s port there', async () => {
    const { deps } = relay();
    expect(await typedRemoteAddress(`http://127.0.0.1:${SERVED_PORT}/docs/a.html`, 'ssh+host-1', deps.tunnels(), deps.policy, [SERVED_PORT])).toEqual({ allowed: true, url: `http://127.0.0.1:${SERVED_PORT}/docs/a.html` });
  });

  it('passes a tool without an address as it came', async () => {
    const { deps, run } = relay();
    await relayBrowserTool(deps, request('BrowserClick', { ref: 'e3' }), new AbortController().signal);
    expect(run.mock.calls[0]?.[0].input).toEqual({ ref: 'e3' });
  });
});
