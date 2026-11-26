// A terminal host as the hub sees it, for the daemon's tests: what the hub sent it, and the events a test sends as the host.
import type { HostMessage } from '../../pty-host/protocol';
import type { HostedTerminal } from '../../terminal-host/host-messages';
import type { TerminalHubDeps } from '../terminal-hub';
import type { ForwardedConnection, HostLink, KillOutcome } from '../terminal-hosts';

// what the hub sent a host: a request or event by its name, with its payload's fields
export type Sent = { readonly type: string } & Record<string, unknown>;

export interface FakeHost {
  readonly link: HostLink;
  readonly sent: Sent[];
  // an event from the host
  fromHost(message: HostMessage): void;
  // a connection on one of the host's endpoints, forwarded to the daemon
  forward(connection: ForwardedConnection): void;
  // whether the hub or the test closed the link
  closed(): boolean;
}

// As a real host's link: a request on a closed link fails, a kill of a terminal it holds sends that terminal's exit before its
// answer, and a close listener set after the close runs at once.
export function fakeHost(pid: number, version: string, terminals: readonly HostedTerminal[] = [], onSent: (sent: Sent) => void = () => undefined): FakeHost {
  const sent: Sent[] = [];
  const closers: Array<(reason: string) => void> = [];
  const holds = new Set(terminals.map((terminal) => terminal.id));
  let deliver: (message: HostMessage) => void = () => undefined;
  let take: (connection: ForwardedConnection) => void = () => undefined;
  let closed: string | undefined;
  const record = (type: string, payload: unknown): void => {
    const entry = { type, ...(payload as object) };
    sent.push(entry);
    onSent(entry);
  };
  const link: HostLink = {
    pid,
    version,
    terminals,
    endpoint: {
      request: ((name: string, params: { readonly id?: string }) => {
        record(name, params);
        if (closed !== undefined) return Promise.reject(new Error(`the link closed: ${closed}`));
        if (name === 'spawn' && params.id !== undefined) holds.add(params.id);
        if (name !== 'kill' || params.id === undefined || !holds.delete(params.id)) return Promise.resolve(undefined);
        const { id } = params;
        return Promise.resolve().then(() => {
          deliver({ type: 'exit', id, exitCode: 1 });
          return undefined;
        });
      }) as HostLink['endpoint']['request'],
      emit: ((name: string, payload: unknown) => record(name, payload)) as HostLink['endpoint']['emit'],
    },
    relayNonce: undefined,
    onMessage: (listener) => { deliver = listener; },
    onConnection: (listener) => { take = listener; },
    onClose: (listener) => {
      if (closed !== undefined) listener(closed);
      else closers.push(listener);
    },
    close: (reason) => {
      if (closed !== undefined) return;
      closed = reason;
      for (const closer of closers) closer(reason);
    },
  };
  return { link, sent, fromHost: (message) => deliver(message), forward: (connection) => take(connection), closed: () => closed !== undefined };
}

export interface FakeHosts {
  readonly hosts: TerminalHubDeps['hosts'];
  // a host the daemon attached to, or attached to again under the same pid
  adopt(host: FakeHost): void;
  // a host the daemon found ended
  end(pid: number): void;
  // a lost host stayed out of reach past the reattach wait (false), or attached again (true)
  respond(pid: number, responding: boolean): void;
  // a recorded host whose first attach failed, with the terminals its file names
  unattached(pid: number, terminals: readonly HostedTerminal[]): void;
  // what each later killGroup answers; killed until set
  killAnswers(outcome: KillOutcome): void;
  readonly emptied: HostLink[];
  // what was asked: endAll, endForRemoval, release, killGroup <host pid> <id>, endHost <pid>
  readonly calls: string[];
}

// current: the host new terminals start in, attached at the first spawn; endHost answers ended
export function fakeHosts(current: FakeHost, ended = false): FakeHosts {
  const listeners: Array<(link: HostLink) => void> = [];
  const endedListeners: Array<(pid: number) => void> = [];
  const respondingListeners: Array<(pid: number, responding: boolean) => void> = [];
  const unattachedListeners: Array<(pid: number, terminals: readonly HostedTerminal[]) => void> = [];
  const emptied: HostLink[] = [];
  const calls: string[] = [];
  let started = false;
  let killOutcome: KillOutcome = 'killed';
  const adopt = (host: FakeHost): void => {
    for (const listener of listeners) listener(host.link);
  };
  return {
    hosts: {
      currentHost: () => {
        if (!started) adopt(current);
        started = true;
        return Promise.resolve(current.link);
      },
      onLink: (listener) => { listeners.push(listener); },
      onEnded: (listener) => { endedListeners.push(listener); },
      onResponding: (listener) => { respondingListeners.push(listener); },
      onUnattached: (listener) => { unattachedListeners.push(listener); },
      killGroup: (hostPid, id) => {
        calls.push(`killGroup ${hostPid} ${id}`);
        return Promise.resolve(killOutcome);
      },
      endHost: (pid) => {
        calls.push(`endHost ${pid}`);
        return Promise.resolve(ended);
      },
      emptied: (link) => { emptied.push(link); },
      endAll: () => {
        calls.push('endAll');
        return Promise.resolve();
      },
      endForRemoval: () => {
        calls.push('endForRemoval');
        return Promise.resolve();
      },
      release: (reason) => { calls.push(`release: ${reason}`); },
    },
    adopt,
    end: (pid) => { for (const listener of endedListeners) listener(pid); },
    respond: (pid, responding) => { for (const listener of respondingListeners) listener(pid, responding); },
    unattached: (pid, terminals) => { for (const listener of unattachedListeners) listener(pid, terminals); },
    killAnswers: (outcome) => { killOutcome = outcome; },
    emptied,
    calls,
  };
}

// the hub sends a spawn once the current host answered
export const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
