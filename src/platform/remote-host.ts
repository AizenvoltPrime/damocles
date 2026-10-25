import type { BrokerAnswer, ClientPolicy, ClientUser, HeldAuth } from '../shared/remote-user';
import type { Disposable } from './disposable';
import type { PanelHost } from './window-service';

export type ClientTopic = 'clientAuth' | 'clientUser' | 'clientPolicy' | 'actingClient';

/** The per-client mirrors of a daemon's core, by the daemon's id for each attached client. */
export interface ClientSnapshots {
  // the client that most recently sent core a message; undefined with no client attached
  acting(): string | undefined;
  // expiries stamped on this host's clock when the snapshot arrived; a detached client's last one stays
  auth(clientId: string): HeldAuth | undefined;
  user(clientId: string): ClientUser | undefined;
  policy(clientId: string): ClientPolicy | undefined;
  // before: a per-client topic's previous value for that client
  onDidChange(cb: (change: { readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown }) => void): Disposable;
}

/** A daemon's core: user scope, AI sign-ins, voice and the trash are its clients', never this host's. */
export interface RemoteHost {
  readonly hostId: string;
  readonly clients: ClientSnapshots;
  // the token broker's ask, answered by exactly that client; rejects with CREDENTIAL_CLIENT_ABSENT when it is gone
  credentials(provider: string, clientId: string): Promise<BrokerAnswer>;
  // speak a chat's final reply on the client showing its view
  speak(host: PanelHost, text: string): Promise<void>;
  // the providers a chat's runs read through the broker, for the daemon's run registry (control.listRuns)
  runProviders(panelId: string, providers: readonly string[]): void;
}
