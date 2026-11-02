import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserAgentScope, remoteProfileDir, type BrowserService, type BrowserServices } from '../../../core/browser';
import type { PiCodingAgentModule } from '../../../core/pi-session/pi-loader';
import type { PanelHost } from '../../../platform/window-service';
import { createRemoteBrowsers } from '../browser-relay';
import { LocalizedError } from '../../../shared/localized-text';

const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;

function setup(options: { enabled?: () => boolean } = {}) {
  const scopes: Array<{ readonly kind: 'chat' | 'agent'; readonly id: string; readonly chat: PanelHost }> = [];
  const savedPath = join(remoteProfileDir('ssh+host-1'), 'damocles-downloads', 'launch1', 'report.pdf');
  const downloads = [{ filename: 'report.pdf', savedPath, url: 'http://localhost:5174/report.pdf', state: 'completed' as const }];
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
  };
  const authorities: string[] = [];
  const released: string[] = [];
  const browsers = {
    forAuthority: (authority: string) => { authorities.push(authority); return service as unknown as BrowserService; },
    release: async (authority: string) => { released.push(authority); },
  } as unknown as BrowserServices;
  const host = { onDispose: () => ({ dispose: () => undefined }) } as unknown as PanelHost;
  const relay = createRemoteBrowsers({ browsers, foreign: (viewId) => (viewId === 'view-1' ? { host, authority: 'ssh+host-1' } : undefined), pi: () => pi, enabled: options.enabled ?? (() => true) });
  return { relay, scopes, authorities, released, host, service };
}

const signal = new AbortController().signal;

describe('a remote chat\'s browser tool on this computer\'s core', () => {
  it('runs in the authority\'s context, in the chat\'s own scope or the agent\'s scope keyed by the view', async () => {
    const { relay, scopes, authorities, host } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
    expect(authorities).toEqual(['ssh+host-1', 'ssh+host-1']);
    expect(scopes).toEqual([{ kind: 'chat', id: 'chat-1', chat: host }, { kind: 'agent', id: 'view-1/agent-7', chat: host }]);
  });

  it('answers a saved download by its file name, never its path on this computer', async () => {
    const { relay } = setup();
    const answer = await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} }, signal);
    expect(answer.content).toEqual([{ type: 'text', text: 'Recent downloads (1):\nreport.pdf — report.pdf — http://localhost:5174/report.pdf [completed]' }]);
  });

  it('disposes an agent\'s scope it built when the remote core releases it, with that agent\'s tab rule, and nothing else', async () => {
    const { relay, service } = setup();
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-8', tool: 'BrowserDownloads', input: {} }, signal);
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
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
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
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
    expect(authorities).toEqual(['ssh+host-1']);
    await relay.releaseAuthority('ssh+host-1');
    expect(released).toEqual(['ssh+host-1']);
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'agent-7', tool: 'BrowserDownloads', input: {} }, signal);
    expect(authorities).toEqual(['ssh+host-1', 'ssh+host-1']);
    expect(scopes).toHaveLength(2);
  });

  it('refuses every call while this computer\'s browser is off, with a reason in both languages, and starts nothing', async () => {
    let enabled = false;
    const { relay, authorities } = setup({ enabled: () => enabled });
    const refusal = await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserOpen', input: { url: 'http://localhost:5174/' } }, signal).then(() => undefined, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(LocalizedError);
    expect((refusal as LocalizedError).text).toEqual({ message: "The browser is off on the computer that shows this chat. Turn it on in Damocles' Settings there." });
    expect(authorities).toEqual([]);
    enabled = true;
    await relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} }, signal);
    expect(authorities).toEqual(['ssh+host-1']);
  });

  it('refuses a view of another authority, an unknown tool and an input outside the tool\'s schema', async () => {
    const { relay } = setup();
    await expect(relay.tool({ authority: 'ssh+host-2', viewId: 'view-1', scope: 'chat', tool: 'BrowserDownloads', input: {} }, signal)).rejects.toThrow('not attached');
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'Bash', input: {} }, signal)).rejects.toThrow('not a browser tool');
    await expect(relay.tool({ authority: 'ssh+host-1', viewId: 'view-1', scope: 'chat', tool: 'BrowserNavigate', input: { url: 42 } }, signal)).rejects.toThrow('does not match its schema');
  });
});
