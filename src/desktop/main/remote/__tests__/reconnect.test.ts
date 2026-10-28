import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectFailure } from '../../../preload/overlay-channels';
import type { ProjectConnection } from '../../../preload/shell-channels';
import { ATTEMPT_TIMEOUT_MS, backoffMs, NETWORK_SAMPLE_MS, permanentFailureOf, RECONNECT_BACKOFF_S, Reconnector, type HeldConnection, type ReconnectEvent } from '../reconnect';

const KEY = 'ssh+h1';

class ConnectError extends Error {
  readonly failure: ConnectFailure;
  constructor(failure: ConnectFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

// Authorities as the loop reads it, driven by hand: a held connection, its state, and attempts the test settles.
function harness(options: { views?: boolean; hostExists?: boolean } = {}) {
  let state: ProjectConnection = 'connected';
  let connection: (HeldConnection & { isLost: boolean; suspect: number | undefined }) | undefined;
  let views = options.views ?? true;
  let signIn = false;
  let staging = false;
  let watched = false;
  // the next attempt finds one running that the loop did not start (a Connect dialog's, a selection's)
  let joinNext = false;
  // the next attempt is refused before it starts (a removal stage runs)
  let refuseNext: Error | undefined;
  let handedOff = false;
  let lastFailure: ConnectFailure | undefined;
  let online = true;
  const logs: string[] = [];
  const attempts: Array<{ readonly signal: AbortSignal; readonly force: boolean; readonly joined: boolean; resolve: () => void; reject: (failure: ConnectFailure) => void }> = [];
  const endedMasters: string[] = [];
  const events: ReconnectEvent[] = [];
  const usable = (): boolean => state === 'connected' && connection !== undefined && !connection.isLost && connection.suspect === undefined;
  const reconnector = new Reconnector({
    state: () => state,
    usable: () => usable(),
    held: () => connection,
    hostExists: () => options.hostExists ?? true,
    hasOpenViews: () => views,
    attempt: (_key, signal, force) => {
      if (refuseNext) {
        const refused = refuseNext;
        refuseNext = undefined;
        throw refused;
      }
      const joined = joinNext;
      joinNext = false;
      const outcome = new Promise<void>((resolve, reject) => {
        state = 'connecting';
        attempts.push({ signal, force, joined, resolve, reject: (failure) => reject(new ConnectError(failure)) });
      });
      return { joined, outcome };
    },
    staging: () => staging,
    watched: () => watched,
    failureOf: (err) => (err as ConnectError).failure,
    handedOff: () => handedOff,
    lastFailure: () => lastFailure,
    signInNeeded: () => signIn,
    endMaster: async (key) => {
      endedMasters.push(key);
    },
    online: () => online,
    log: (line) => { logs.push(line); },
  });
  reconnector.onEvent((event) => events.push(event));
  const fresh = (): HeldConnection & { isLost: boolean; suspect: number | undefined } => {
    const made = { isLost: false, suspect: undefined as number | undefined, lost: () => made.isLost, suspectSince: () => made.suspect };
    return made;
  };
  return {
    reconnector,
    events,
    attempts,
    endedMasters,
    logs,
    setOnline: (value: boolean) => { online = value; },
    joinNext: () => { joinNext = true; },
    refuseNext: (failure: ConnectFailure) => { refuseNext = new ConnectError(failure); },
    // the attempt reported a step or progress
    setStaging: (value: boolean) => {
      staging = value;
      reconnector.attemptChanged(KEY);
    },
    setWatched: (value: boolean) => {
      watched = value;
      reconnector.attemptChanged(KEY);
    },
    kinds: () => events.map((event) => event.kind),
    connect: () => {
      connection = fresh();
      state = 'connected';
      reconnector.stateChanged(KEY);
      return connection;
    },
    drop: () => {
      connection!.isLost = true;
      state = 'failed';
      reconnector.stateChanged(KEY);
    },
    suspect: (since: number) => {
      connection!.suspect = since;
      state = 'connecting';
      reconnector.stateChanged(KEY);
    },
    // the attempt landed: resumed keeps the held connection, otherwise a fresh one replaces it
    // as Authorities does: the state reaches the loop before the attempt's promise settles
    land: (how: 'resumed' | 'attached') => {
      if (how === 'attached') connection = fresh();
      else connection!.isLost = false;
      state = 'connected';
      reconnector.stateChanged(KEY);
      attempts.at(-1)!.resolve();
    },
    failAttempt: (failure: ConnectFailure) => {
      state = 'failed';
      attempts.at(-1)!.reject(failure);
    },
    // the suspect state cleared: Authorities reports the same connection connected again
    recover: () => {
      connection!.suspect = undefined;
      state = 'connected';
      reconnector.stateChanged(KEY);
    },
    closeForGood: () => {
      connection = undefined;
      state = 'failed';
      reconnector.stateChanged(KEY);
    },
    setViews: (open: boolean) => { views = open; },
    // the update flow took the authority (a daemon of another protocol answered)
    handOff: (taken: boolean) => {
      handedOff = taken;
      reconnector.stateChanged(KEY);
    },
    // Authorities after Disconnect Host, or after a shutdown this client asked for
    disconnect: () => {
      connection = undefined;
      state = 'offline';
      reconnector.stateChanged(KEY);
    },
    setSignIn: (waiting: boolean) => {
      signIn = waiting;
      reconnector.attemptChanged(KEY);
    },
    failedOutside: (failure: ConnectFailure) => {
      lastFailure = failure;
      state = 'failed';
      reconnector.stateChanged(KEY);
      reconnector.attemptChanged(KEY);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a handed-off authority', () => {
  it('runs no reconnect loop while the update flow follows a daemon of another protocol there, and loops again once it let go', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(1);
    h.handOff(true);
    h.failAttempt({ code: 'handshakeFailed', params: { reason: 'another protocol' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.kinds().at(-1)).toBe('idle');
    h.closeForGood();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.attempts).toHaveLength(1);
    h.handOff(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(2);
  });
});

describe('the backoff schedule', () => {
  it('waits 0, 5, 5, 10, 10, 10, 10, 10 and 30 s, then every 30 s forever', () => {
    expect(RECONNECT_BACKOFF_S).toEqual([0, 5, 5, 10, 10, 10, 10, 10, 30]);
    expect(Array.from({ length: 12 }, (_, index) => backoffMs(index) / 1000)).toEqual([0, 5, 5, 10, 10, 10, 10, 10, 30, 30, 30, 30]);
  });

  it('attempts on that schedule after a drop, never giving up while views are open', async () => {
    const h = harness();
    h.connect();
    const droppedAt = Date.now();
    h.drop();
    expect(h.reconnector.phase(KEY)).toEqual({ phase: 'waiting', since: droppedAt, retryAt: droppedAt });
    const startedAt: number[] = [];
    for (let index = 0; index < 11; index++) {
      await vi.advanceTimersByTimeAsync(backoffMs(index));
      expect(h.attempts).toHaveLength(index + 1);
      startedAt.push(Date.now() - droppedAt);
      h.failAttempt({ code: 'refused', params: {} });
      await vi.advanceTimersByTimeAsync(0);
    }
    const gaps = startedAt.map((at, index) => at - (index === 0 ? 0 : startedAt[index - 1]!));
    expect(gaps.map((gap) => gap / 1000)).toEqual([0, 5, 5, 10, 10, 10, 10, 10, 30, 30, 30]);
    expect(h.reconnector.phase(KEY)).toMatchObject({ phase: 'waiting', since: droppedAt });
  });

  it('times an attempt out after 30 s and goes on with the schedule', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attempts[0]!.signal.aborted).toBe(true);
    // the aborted attempt reports cancelled, which a timeout does not count as the user's cancel
    h.failAttempt({ code: 'cancelled', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)?.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.attempts).toHaveLength(2);
  });
});

describe('the reconnect loop', () => {
  it('loops only for an authority with open views', async () => {
    const h = harness({ views: false });
    h.connect();
    h.drop();
    expect(h.reconnector.phase(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(0);
  });

  it('stops once the views close, at the next attempt', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.failAttempt({ code: 'timedOut', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    h.setViews(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.attempts).toHaveLength(1);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
    expect(h.kinds().at(-1)).toBe('idle');
  });

  it('reports lost, wait, running and a resumed gain for the same connection', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.land('resumed');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.kinds()).toEqual(['lost', 'wait', 'running', 'gain']);
    // the attempt that connected is never aborted, which would kill the transport it resumed over
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    expect(h.events.at(-1)).toEqual({ kind: 'gain', gain: { authorityKey: KEY, how: 'resumed' } });
    expect(h.reconnector.phase(KEY)).toBeUndefined();
  });

  it('leaves the gain of a fresh connection to attached, after its chats reopened', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.land('attached');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.kinds()).not.toContain('gain');
    h.reconnector.attached({ authorityKey: KEY, how: 'attached', restarted: 'server' });
    expect(h.events.at(-1)).toEqual({ kind: 'gain', gain: { authorityKey: KEY, how: 'attached', restarted: 'server' } });
  });

  it('is suspect from the missed deadline, attempts nothing while suspect, and a cleared suspect state is a resumed gain', async () => {
    const h = harness();
    const connection = h.connect();
    h.suspect(1234);
    expect(h.reconnector.phase(KEY)).toEqual({ phase: 'suspect', since: 1234 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(0);
    expect(connection.lost()).toBe(false);
    h.recover();
    expect(h.kinds()).toEqual(['suspect', 'gain']);
    expect(h.events.at(-1)).toEqual({ kind: 'gain', gain: { authorityKey: KEY, how: 'resumed' } });
  });

  it('keeps the suspect state\'s since when the silence turns into a drop', async () => {
    const h = harness();
    const connection = h.connect();
    h.suspect(1234);
    connection.suspect = undefined;
    h.drop();
    expect(h.reconnector.phase(KEY)).toMatchObject({ phase: 'waiting', since: 1234 });
    expect(h.kinds()).toEqual(['suspect', 'lost', 'wait']);
  });

  it('stops at a prompt behind the sign-in banner with the timeout paused, and goes on once it is answered', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.setSignIn(true);
    expect(h.reconnector.phase(KEY)?.phase).toBe('signIn');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    h.setSignIn(false);
    expect(h.reconnector.phase(KEY)?.phase).toBe('running');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.attempts[0]!.signal.aborted).toBe(true);
  });

  it('stops at a permanent failure until Retry, which attempts at once', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.failAttempt({ code: 'hostKeyChanged', params: { host: 'prod-1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)).toMatchObject({ phase: 'failed', code: 'hostKeyChanged' });
    expect(h.events.at(-1)).toEqual({ kind: 'permanent', authorityKey: KEY, code: 'hostKeyChanged', dropped: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.attempts).toHaveLength(1);
    h.reconnector.reconnectNow(KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(2);
  });

  it('fails a removed host permanently before attempting', async () => {
    const h = harness({ hostExists: false });
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(0);
    expect(h.reconnector.phase(KEY)).toMatchObject({ phase: 'failed', code: 'hostRemoved' });
  });

  it('Reconnect now restarts the backoff and attempts at once', async () => {
    const h = harness();
    h.connect();
    h.drop();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(backoffMs(index));
      h.failAttempt({ code: 'refused', params: {} });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.attempts).toHaveLength(4);
    h.reconnector.reconnectNow(KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(5);
    h.failAttempt({ code: 'refused', params: {} });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.attempts).toHaveLength(6);
  });

  it('wakes a waiting loop on a resume from sleep, Damocles\' master ended before the attempt', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.failAttempt({ code: 'refused', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(1);
    h.reconnector.wake('resumed');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.endedMasters).toEqual([KEY]);
    expect(h.attempts).toHaveLength(2);
  });

  it('attempts at once when the network comes back, Damocles\' master ended first, and not while it stays up', async () => {
    const h = harness();
    h.connect();
    h.setOnline(false);
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.failAttempt({ code: 'unresolved', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(1);
    // the schedule's next attempt is 5 s away; one network sample later the loop attempts
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(NETWORK_SAMPLE_MS - 1);
    expect(h.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attempts).toHaveLength(2);
    expect(h.endedMasters).toEqual([KEY]);
    expect(h.logs).toContain(`[remote] ${KEY}: the network came back; attempting at once`);

    const steady = harness();
    steady.connect();
    steady.drop();
    await vi.advanceTimersByTimeAsync(0);
    steady.failAttempt({ code: 'unresolved', params: {} });
    await vi.advanceTimersByTimeAsync(backoffMs(1) - 1);
    expect(steady.attempts).toHaveLength(1);
    expect(steady.endedMasters).toEqual([]);
  });

  it('after a launch connect failed it waits for the second step, and that attempt\'s cancel ends the loop', async () => {
    const h = harness();
    h.failedOutside({ code: 'refused', params: {} });
    expect(h.reconnector.phase(KEY)?.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attempts).toHaveLength(1);
    const cancelled = harness();
    cancelled.failedOutside({ code: 'cancelled', params: {} });
    expect(cancelled.reconnector.phase(KEY)).toBeUndefined();
    const permanent = harness();
    permanent.failedOutside({ code: 'glibcTooOld', params: {} });
    expect(permanent.reconnector.phase(KEY)).toMatchObject({ phase: 'failed', code: 'prerequisites' });
    expect(permanent.events.at(-1)).toMatchObject({ kind: 'permanent', dropped: false });
  });

  it('a connection closed for good loops as a drop and lands as a fresh attach', async () => {
    const h = harness();
    h.connect();
    h.closeForGood();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts).toHaveLength(1);
    h.land('attached');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
    expect(h.kinds()).not.toContain('gain');
  });

  it('ends a loop the drop started once the authority is disconnected, as after a shutdown this client asked for', async () => {
    const h = harness();
    h.connect();
    h.drop();
    expect(h.reconnector.phase(KEY)?.phase).toBe('waiting');
    h.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(0);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
  });

  it('stops for good after the user disconnected', async () => {
    const h = harness();
    h.connect();
    h.drop();
    h.reconnector.disconnected(KEY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(0);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
  });
});

describe('the attempt timeout', () => {
  it('never aborts an attempt once stage 1 runs on the target, however long it installs', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS - 5000);
    // checking, then installing with progress reports, past the timeout
    h.setStaging(true);
    for (let second = 0; second < 120; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.setStaging(true);
    }
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    h.land('attached');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
  });

  it('never times out an attempt a user watches in the Connect dialog', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.setWatched(true);
    await vi.advanceTimersByTimeAsync(10 * ATTEMPT_TIMEOUT_MS);
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    // closing the dialog leaves it to the user's attempt, unbounded
    h.setWatched(false);
    h.setSignIn(true);
    h.setSignIn(false);
    await vi.advanceTimersByTimeAsync(10 * ATTEMPT_TIMEOUT_MS);
    expect(h.attempts[0]!.signal.aborted).toBe(false);
  });

  it('awaits an attempt it did not start with no timeout, and that attempt\'s cancel ends the loop', async () => {
    const h = harness();
    h.connect();
    h.drop();
    h.joinNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts[0]!.joined).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * ATTEMPT_TIMEOUT_MS);
    expect(h.attempts[0]!.signal.aborted).toBe(false);
    expect(h.reconnector.phase(KEY)?.phase).toBe('running');
    h.failAttempt({ code: 'cancelled', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)).toBeUndefined();
  });

  it('fails an attempt the transport refused to start and goes on with the schedule', async () => {
    const h = harness();
    h.connect();
    h.refuseNext({ code: 'handshakeFailed', params: { reason: 'An ssh call to h1 is running; connect once it finished' } });
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)?.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    expect(h.attempts).toHaveLength(1);
  });
});

describe('a suspect connection', () => {
  it('Reconnect now gives up its transport, and the scheduled attempts never do', async () => {
    const h = harness();
    h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    h.failAttempt({ code: 'refused', params: {} });
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    h.failAttempt({ code: 'refused', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    h.reconnector.reconnectNow(KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts.map((attempt) => attempt.force)).toEqual([false, false, true]);
  });

  it('goes on with the schedule when an attempt connected but the connection is no longer usable', async () => {
    const h = harness();
    const connection = h.connect();
    h.drop();
    await vi.advanceTimersByTimeAsync(0);
    // resumed, and silent again before the loop saw it usable
    connection.isLost = false;
    connection.suspect = Date.now();
    h.attempts[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnector.phase(KEY)?.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    expect(h.attempts).toHaveLength(2);
  });
});

describe('failure classification', () => {
  it('names the permanent failures and leaves the rest to the schedule', () => {
    const of = (code: ConnectFailure['code']) => permanentFailureOf({ code, params: {} });
    expect(of('hostKeyChanged')).toBe('hostKeyChanged');
    for (const code of ['unsupportedOs', 'glibcTooOld', 'glibcxxMissing', 'kernelTooOld', 'macosTooOld', 'windowsBuildTooOld', 'nixLdMissing', 'noexec', 'lowSpace', 'installFolderInvalid'] as const) expect(of(code)).toBe('prerequisites');
    for (const code of ['hashMismatch', 'downloadAndUploadFailed', 'selfTestFailed'] as const) expect(of(code)).toBe('install');
    expect(of('permissionDenied')).toBe('authFailed');
    expect(of('hostKeyRefused')).toBe('authFailed');
    expect(of('destinationRefused')).toBe('destination');
    for (const code of ['refused', 'timedOut', 'unreachable', 'unresolved', 'unknown', 'bridgeFailed', 'handshakeFailed', 'cancelled'] as const) expect(of(code)).toBeUndefined();
  });
});
