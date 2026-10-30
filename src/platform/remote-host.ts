import type { BrokerAnswer, ClientPolicy, ClientUser, HeldAuth } from '../shared/remote-user';
import type { Disposable } from './disposable';
import type { ActiveEditorContext } from './editor-service';
import type { PanelHost, TerminalToggle } from './window-service';

export type ClientTopic = 'clientAuth' | 'clientUser' | 'clientPolicy' | 'clientEditor' | 'clientTerminal' | 'clientLanguage' | 'actingClient';

/** The per-client mirrors of a daemon's core, by the daemon's id for each attached client. */
export interface ClientSnapshots {
  // the client whose request or panel message the work in progress came from; undefined outside one
  actor(): string | undefined;
  // actor() while it is attached, else the client that most recently sent core a message; undefined with none attached
  acting(): string | undefined;
  // whether the client is attached now, its connection outside its reconnection grace; a client is named by its device's
  // stable id, so a relaunch of that device attaches under the same id
  attached(clientId: string): boolean;
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
  // before: a per-client topic's previous value for that client; detached: the topic's delta had no value, as the client detached
  onDidChange(cb: (change: { readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown; readonly detached?: true }) => void): Disposable;
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
}
