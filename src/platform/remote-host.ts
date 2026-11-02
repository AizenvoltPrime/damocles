import type { BrokerAnswer, BrowserToolAnswer, ClientGlobalProfile, ClientPolicy, ClientUser, GlobalMemoryResolution, GlobalMemorySearchFilters, GlobalMemoryWrite, HeldAuth, HeldMemoryQueue, RelayedMcpServer, SearchedGlobalMemory } from '../shared/remote-user';

import type { Disposable } from './disposable';
import type { ActiveEditorContext } from './editor-service';
import type { PanelHost, TerminalToggle } from './window-service';

export type ClientTopic = 'clientAuth' | 'clientUser' | 'clientPolicy' | 'clientEditor' | 'clientTerminal' | 'clientLanguage' | 'clientMcp' | 'actingClient';

/** The per-client mirrors of a daemon's core, by the daemon's id for each attached client. */
export interface ClientSnapshots {
  // the client whose request or panel message the work in progress came from; undefined outside one
  actor(): string | undefined;
  // actor() while it is attached, else the client that most recently sent core a message; undefined with none attached
  acting(): string | undefined;
  // whether the client is attached now, its connection outside its reconnection grace; a client is named by its device's
  // stable id, so a relaunch of that device attaches under the same id
  attached(clientId: string): boolean;
  // whether any client is attached now
  anyAttached(): boolean;
  // the clients attached now
  attachedClients(): readonly string[];
  // expiries stamped on this host's clock when the snapshot arrived; a detached client's last one stays
  auth(clientId: string): HeldAuth | undefined;
  user(clientId: string): ClientUser | undefined;
  policy(clientId: string): ClientPolicy | undefined;
  // the client's focused text editor; undefined when none has focus or the client is detached
  editor(clientId: string): ActiveEditorContext | undefined;
  // undefined while the client is detached
  terminal(clientId: string): TerminalToggle | undefined;
  // the client's UI language, which its views render core's text in; undefined while the client is detached
  language(clientId: string): 'en' | 'el' | undefined;
  // the personal MCP servers the client marked available on remote hosts; a detached client's last ones stay
  mcp(clientId: string): readonly RelayedMcpServer[] | undefined;
  // the clients whose relayed MCP servers core holds, detached ones included
  mcpClients(): readonly string[];
  // before: a per-client topic's previous value for that client; detached: the topic's delta had no value, as the client detached
  onDidChange(cb: (change: { readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown; readonly detached?: true }) => void): Disposable;
}

/** One output stream of an agent shell, as the daemon's port detection reads it. */
export interface ShellOutputSink {
  write(chunk: Uint8Array): void;
  end(): void;
}

/** A daemon's core: user scope, AI sign-ins, voice and the trash are its clients', never this host's. */
export interface RemoteHost {
  readonly hostId: string;
  readonly clients: ClientSnapshots;
  // the daemon's proxy socket for that client's forwarded agent, which reaches only that client's agent; undefined on a
  // target without one (Windows)
  agentSocket(clientId: string): string | undefined;
  // the token broker's ask, answered by exactly that client; rejects with CREDENTIAL_CLIENT_ABSENT when it is gone
  credentials(provider: string, clientId: string): Promise<BrokerAnswer>;
  // speak a chat's final reply on the client showing its view
  speak(host: PanelHost, text: string): Promise<void>;
  // the providers a chat's runs read through the broker, for the daemon's run registry (control.listRuns)
  runProviders(panelId: string, providers: readonly string[]): void;
  // a browser tool of the chat's view, run by the client showing it in that view's browser scope
  browserTool(host: PanelHost, scope: string, tool: string, input: unknown, signal: AbortSignal | undefined): Promise<BrowserToolAnswer>;
  // a subagent's or team member's browser scope of the chat ended: the client showing the chat disposes it there, closing its
  // tabs when closeTabs
  browserRelease(host: PanelHost, scope: string, closeTabs: boolean): Promise<void>;
  // the conversation that handed out an agent's browser scope ended: the client showing the chat closes every tab of the
  // scope there, those a failed agent left open included
  browserDiscard(host: PanelHost, scope: string): Promise<void>;
  // an agent shell's output, read for loopback URLs the daemon's port detection forwards; one sink per output stream (stdout,
  // stderr), each decoding on its own, ended when its stream ends so a last line without a newline counts
  shellOutput(): ShellOutputSink;
  // exactly that client's global memory (user.memory.*), each refused with CREDENTIAL_CLIENT_ABSENT while it is gone: its own
  // ranked search (injection: its injection's lexical gate; filters as search_memories applies them), its global profile, the current version of ids it returned before,
  // and writes it applies in order, resolving the byte offset after the last entry it applied and the row each applied write
  // is in, in order (absent from a client that does not say)
  memorySearch(clientId: string, query: string, k: number, tiers: readonly ('global' | 'note')[], injection?: boolean, filters?: GlobalMemorySearchFilters): Promise<readonly SearchedGlobalMemory[]>;
  memoryProfile(clientId: string): Promise<ClientGlobalProfile>;
  memoryResolve(clientId: string, ids: readonly string[]): Promise<readonly GlobalMemoryResolution[]>;
  memoryApply(clientId: string, entries: readonly { readonly end: number; readonly write: GlobalMemoryWrite }[]): Promise<{ readonly through: number; readonly ids?: readonly string[] }>;
  // the outboxes held for devices long away, which every attached client shows with Deliver here and Discard
  heldMemoryChanged(queues: readonly HeldMemoryQueue[]): void;
  // exactly that client's personal MCP server, which it runs (user.mcp.*); each answer is the server's MCP result
  mcpCall(clientId: string, server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<unknown>;
  mcpResources(clientId: string, server: string, kind: 'resources' | 'templates', cursor: string | undefined, signal: AbortSignal | undefined): Promise<unknown>;
  mcpReadResource(clientId: string, server: string, uri: string, signal: AbortSignal | undefined): Promise<unknown>;
}
