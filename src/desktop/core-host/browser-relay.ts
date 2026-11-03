// This computer's core runs a remote chat's browser tools (user.browser.tool): in the authority's own context, in a scope keyed
// by the chat's view and the agent's scope there, with the chat's foreign view proxy owning the pages, so they show as its tabs.
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Check } from 'typebox/value';
import { join } from 'node:path';
import { remoteProfileDir, type BrowserAgentScope, type BrowserServices } from '../../core/browser';
import { l } from '../../core/l10n';
import type { PiCodingAgentModule } from '../../core/pi-session/pi-loader';
import { buildBrowserPiTools } from '../../core/pi-session/tools/browser-tools';
import type { PanelHost } from '../../platform/window-service';
import { LocalizedError } from '../../shared/localized-text';
import { CHAT_BROWSER_SCOPE, FOREIGN_VIEW_NOT_ATTACHED, type BrowserToolAnswer } from '../../shared/remote-user';

export interface RemoteBrowsersDeps {
  readonly browsers: BrowserServices;
  // the remote chat view's proxy on this core and its authority
  readonly foreign: (viewId: string) => { readonly host: PanelHost; readonly authority: string } | undefined;
  readonly pi: () => PiCodingAgentModule | null;
  // this computer's damocles.browser.enabled: Chrome starts here for a remote chat only while it is on
  readonly enabled: () => boolean;
}

export interface RemoteBrowsers {
  tool(params: { readonly authority: string; readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown }, signal: AbortSignal): Promise<BrowserToolAnswer>;
  // an agent's scope of the view ended on the remote core: disposed here as a local agent's is at its settle; a discard, at
  // the end of the conversation that handed the scope out, also closes the tabs a failed agent left open
  release(authority: string, agentScope: { readonly viewId: string; readonly scope: string; readonly closeTabs: boolean; readonly discard?: boolean }): void;
  // Forget host: the authority's context and proxy close, and no scope built in it is used again
  releaseAuthority(authority: string): Promise<void>;
}

export function createRemoteBrowsers(deps: RemoteBrowsersDeps): RemoteBrowsers {
  // authority, view and scope -> that scope's tools; a closed view's proxy is a new host, so its entry is rebuilt
  const built = new Map<string, { readonly authority: string; readonly host: PanelHost; readonly tools: ReadonlyMap<string, ToolDefinition> }>();
  let calls = 0;
  return {
    tool: async ({ authority, viewId, scope, tool, input }, signal) => {
      if (!deps.enabled()) throw new LocalizedError(l('The browser is off on the computer that shows this chat. Turn it on in Damocles\' Settings there.'));
      const view = deps.foreign(viewId);
      if (!view || view.authority !== authority) throw new Error(FOREIGN_VIEW_NOT_ATTACHED);
      const pi = deps.pi();
      if (!pi) throw new Error('pi is not loaded on this computer');
      const key = JSON.stringify([authority, viewId, scope]);
      let entry = built.get(key);
      if (!entry || entry.host !== view.host) {
        const service = deps.browsers.forAuthority(authority);
        const agentScope: BrowserAgentScope = scope === CHAT_BROWSER_SCOPE ? service.chatScope(view.host) : service.createAgentScope(agentScopeId(viewId, scope), view.host);
        entry = { authority, host: view.host, tools: new Map(buildBrowserPiTools({ pi, scope: agentScope }).map((definition) => [definition.name, definition])) };
        built.set(key, entry);
        view.host.onDispose(() => {
          if (built.get(key) === entry) built.delete(key);
        });
      }
      const definition = entry.tools.get(tool);
      if (!definition) throw new Error(`${tool.slice(0, 64)} is not a browser tool`);
      // the target's pi checked the input; it is checked again before it reaches this computer's browser
      if (!Check(definition.parameters, input)) throw new Error(`The input of ${tool} does not match its schema`);
      const result = await definition.execute(`remote-${++calls}`, input as never, signal, undefined, undefined as never);
      // a saved download's path on this computer names the user's account and is no use on the target: its file name stays
      const downloads = join(remoteProfileDir(authority), 'damocles-downloads');
      const content = result.content.map((block) => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text.split(downloads).map((part, index) => (index === 0 ? part : part.replace(/^[\\/][^\\/]+[\\/]/, ''))).join('') };
        if (block.type === 'image') return { type: 'image' as const, data: block.data, mimeType: block.mimeType };
        throw new Error('A browser tool answered a block that is neither text nor an image');
      });
      return { content, ...((result as { isError?: boolean }).isError === true ? { isError: true } : {}) };
    },
    release: (authority, { viewId, scope, closeTabs, discard }) => {
      const key = JSON.stringify([authority, viewId, scope]);
      // the chat's human scope is never an agent's
      if (scope === CHAT_BROWSER_SCOPE) return;
      if (discard === true) {
        // its scope may be disposed already, so the view it names must be one of the authority's this core holds
        if (deps.foreign(viewId)?.authority !== authority) return;
        built.delete(key);
        deps.browsers.forAuthority(authority).discardScope(agentScopeId(viewId, scope));
        return;
      }
      // a scope this core never built for the authority has nothing here to dispose
      if (!built.has(key)) return;
      built.delete(key);
      deps.browsers.forAuthority(authority).disposeScope(agentScopeId(viewId, scope), closeTabs);
    },
    releaseAuthority: async (authority) => {
      for (const [key, entry] of built) {
        if (entry.authority === authority) built.delete(key);
      }
      await deps.browsers.release(authority);
    },
  };
}

const agentScopeId = (viewId: string, scope: string): string => `${viewId}/${scope}`;
