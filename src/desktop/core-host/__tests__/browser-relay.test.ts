import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserAgentScope, remoteProfileDir, type BrowserService, type BrowserServices, type ChatServedPages } from '../../../core/browser';
import type { PiCodingAgentModule } from '../../../core/pi-session/pi-loader';
import type { PanelHost } from '../../../platform/window-service';
import { createRemoteBrowsers } from '../browser-relay';
import { PARITY_CAPTURE_TOOL } from '../../../core/design/parity-capture';
import { LocalizedError } from '../../../shared/localized-text';
import { MAIN_TO_CORE } from '../../core-protocol/messages';
import { INVALID } from '../../core-protocol/schema';

const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;

type Scopes = Array<{ readonly kind: 'chat' | 'agent'; readonly id: string; readonly chat: PanelHost }>;

function fakeService(scopes: Scopes, downloads: readonly unknown[]) {
  const service = {
    chatScope: (chat: PanelHost) => {
      scopes.push({ kind: 'chat', id: 'chat-1', chat });
      return new BrowserAgentScope(service as unknown as BrowserService, 'chat-1');
    },
    createAgentScope: (id: string, chat: PanelHost) => {
      scopes.push({ kind: 'agent', id, chat });
      return new BrowserAgentScope(service as unknown as BrowserService, id);
    },
    getDownloads: () => downloads,
    disposed: [] as Array<[string, boolean]>,
    disposeScope(id: string, closeTabs: boolean) {
      this.disposed.push([id, closeTabs]);
    },
    discarded: [] as string[],
    discardScope(id: string) {
      this.discarded.push(id);
    },
    // each binding of a chat's served pages, and whether it was disposed
    bound: [] as Array<{ readonly chat: PanelHost; readonly pages: ChatServedPages; disposed: boolean }>,
    bindServedPages(chat: PanelHost, pages: ChatServedPages) {
      const binding = { chat, pages, disposed: false };
      this.bound.push(binding);
      return { dispose: () => { binding.disposed = true; } };
    },
  };
  return service;
}

function setup(options: { enabled?: () => boolean } = {}) {
  const scopes: Scopes = [];
  const savedPath = join(remoteProfileDir('ssh+host-1'), 'damocles-downloads', 'launch1', 'report.pdf');
  const downloads = [{ filename: 'report.pdf', savedPath, url: 'http://localhost:5174/report.pdf', state: 'completed' as const }];
  // Forget host releases the authority's service, and the next call gets a new one
  const services = [fakeService(scopes, downloads)];
  const authorities: string[] = [];
  const released: string[] = [];
  const browsers = {
    forAuthority: (authority: string) => { authorities.push(authority); return services.at(-1) as unknown as BrowserService; },
    release: async (authority: string) => { released.push(authority); services.push(fakeService(scopes, downloads)); },
  } as unknown as BrowserServices;
  const disposes: Array<() => void> = [];
  const host = { onDispose: (listener: () => void) => { disposes.push(listener); return { dispose: () => undefined }; } } as unknown as PanelHost;
  const relay = createRemoteBrowsers({ browsers, foreign: (viewId) => (viewId === 'view-1' ? { host, authority: 'ssh+host-1' } : undefined), pi: () => pi, enabled: options.enabled ?? (() => true) });
  return { relay, scopes, authorities, released, host, service: services[0]!, services, closeView: () => { for (const listener of disposes) listener(); } };
}

const signal = new AbortController().signal;

describe('a remote chat\'s browser tool on this computer\'s core', () => {
  it('runs in the authority\'s context, in the chat\'s own scope or the agent\'s scope keyed by the view', async () => {
    const { relay, scopes, authorities, host } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    expect(authorities).toEqual(['ssh+host-1', 'ssh+host-1']);
    expect(scopes).toEqual([{ kind: 'chat', id: 'chat-1', chat: host }, { kind: 'agent', id: 'view-1/agent-7', chat: host }]);
  });

  it('answers a saved download by its file name, never its path on this computer', async () => {
    const { relay } = setup();
    const answer = await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    expect(answer.content).toEqual([{ type: 'text', text: 'Recent downloads (1):\nreport.pdf — report.pdf — http://localhost:5174/report.pdf [completed]' }]);
  });

  it('disposes an agent\'s scope it built when the remote core releases it, with that agent\'s tab rule, and nothing else', async () => {
    const { relay, service } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-8', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'agent-7', closeTabs: true });
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'agent-8', closeTabs: false });
    // the chat's own scope, another authority's view and a scope never built are not this release's
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'chat', closeTabs: true });
    relay.release('ssh+host-2', { viewId: 'view-1', scope: 'agent-7', closeTabs: true });
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'agent-9', closeTabs: true });
    expect(service.disposed).toEqual([['view-1/agent-7', true], ['view-1/agent-8', false]]);
  });

  it('discards an agent\'s scope at its conversation\'s end, after its settle disposed it too, for a view of the authority only', async () => {
    const { relay, service } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'agent-7', closeTabs: false });
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'agent-7', closeTabs: true, discard: true });
    // another authority's view, a view this core does not hold and the chat's own scope are not its to discard
    relay.release('ssh+host-2', { viewId: 'view-1', scope: 'agent-7', closeTabs: true, discard: true });
    relay.release('ssh+host-1', { viewId: 'view-2', scope: 'agent-7', closeTabs: true, discard: true });
    relay.release('ssh+host-1', { viewId: 'view-1', scope: 'chat', closeTabs: true, discard: true });
    expect(service.disposed).toEqual([['view-1/agent-7', false]]);
    expect(service.discarded).toEqual(['view-1/agent-7']);
  });

  it('builds the tools again in the authority\'s new context after Forget host released it', async () => {
    const { relay, scopes, authorities, released } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    expect(authorities).toEqual(['ssh+host-1']);
    await relay.releaseAuthority('ssh+host-1');
    expect(released).toEqual(['ssh+host-1']);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    expect(authorities).toEqual(['ssh+host-1', 'ssh+host-1']);
    expect(scopes).toHaveLength(2);
  });

  it('refuses every call while this computer\'s browser is off, with a reason in both languages, and starts nothing', async () => {
    let enabled = false;
    const { relay, authorities } = setup({ enabled: () => enabled });
    const refusal = await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserOpen', input: { url: 'http://localhost:5174/' }, servedOrigins: [] }, signal).then(() => undefined, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(LocalizedError);
    expect((refusal as LocalizedError).text).toEqual({ message: "The browser is off on the computer that shows this chat. Turn it on in Damocles' Settings there." });
    expect(authorities).toEqual([]);
    enabled = true;
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal);
    expect(authorities).toEqual(['ssh+host-1']);
  });

  it('refuses a view of another authority, an unknown tool and an input outside the tool\'s schema', async () => {
    const { relay } = setup();
    await expect(relay.tool({ authority: 'ssh+host-2', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [] }, signal)).rejects.toThrow('not attached');
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'Bash', input: {}, servedOrigins: [] }, signal)).rejects.toThrow('not a browser tool');
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserNavigate', input: { url: 42 }, servedOrigins: [] }, signal)).rejects.toThrow('does not match its schema');
  });

  it("binds the view proxy's served pages to the grant origins of the view's latest call, and nothing else", async () => {
    const { relay, host, services, closeView } = setup();
    const own = 'http://0123456789abcdef0123456789abcdef.localhost:5000';
    const later = 'http://fedcba9876543210fedcba9876543210.localhost:5001';
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [own] }, signal);
    expect(services[0]!.bound.map(({ chat }) => chat)).toEqual([host]);
    const { pages } = services[0]!.bound[0]!;
    expect(pages.ownsOrigin(own)).toBe(true);
    expect(pages.ownsOrigin(later)).toBe(false);
    // main serves and maps a remote chat's pages: nothing maps or reopens here
    expect(pages.toFile(`${own}/index.html`)).toBe(`${own}/index.html`);
    expect(await pages.restoreTarget('file:///home/u/proj/index.html')).toEqual({ refused: "a remote chat's served page reopens only through its host" });
    // an agent's scope of the view shares its binding, and each call's origins replace the last
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {}, servedOrigins: [later] }, signal);
    expect(services[0]!.bound).toHaveLength(1);
    expect(pages.ownsOrigin(own)).toBe(false);
    expect(pages.ownsOrigin(later)).toBe(true);
    // after Forget host the view binds again in the authority's new service
    await relay.releaseAuthority('ssh+host-1');
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [own] }, signal);
    expect(services[0]!.bound[0]!.disposed).toBe(true);
    expect(services[1]!.bound.map(({ chat, disposed }) => [chat, disposed])).toEqual([[host, false]]);
    expect(services[1]!.bound[0]!.pages.ownsOrigin(own)).toBe(true);
    closeView();
    expect(services[1]!.bound[0]!.disposed).toBe(true);
  });

  it('takes a call that names no servedOrigins off the wire, and its view then holds no grant origin', async () => {
    const { relay, services } = setup();
    const own = 'http://0123456789abcdef0123456789abcdef.localhost:5000';
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {}, servedOrigins: [own] }, signal);
    const { pages } = services[0]!.bound[0]!;
    expect(pages.ownsOrigin(own)).toBe(true);
    const params = MAIN_TO_CORE.requests['user.browser.tool'].params({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} });
    if (params === INVALID) throw new Error('the wire refused a call with no servedOrigins');
    await relay.tool(params, signal);
    expect(pages.ownsOrigin(own)).toBe(false);
  });

  it("runs DesignParity's capture only in a scope of its own, with its schema checked", async () => {
    const { relay, scopes } = setup();
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: PARITY_CAPTURE_TOOL, input: { url: 'http://localhost:5174/', width: 768 }, servedOrigins: [] }, signal)).rejects.toThrow('scope of its own');
    expect(scopes).toEqual([]);
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'design-parity-1', tool: PARITY_CAPTURE_TOOL, input: { url: 'http://localhost:5174/', width: 100 }, servedOrigins: [] }, signal)).rejects.toThrow('does not match its schema');
    const answer = await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'design-parity-1', tool: PARITY_CAPTURE_TOOL, input: { url: 'file:///etc/passwd', width: 768 }, servedOrigins: [] }, signal);
    expect(answer).toEqual({ content: [{ type: 'text', text: '{"failure":"scheme"}' }], isError: true });
  });
});
