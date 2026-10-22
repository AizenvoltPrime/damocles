import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { WindDownPhase } from '../../shared/types/wind-down';

/**
 * Where pi's run on one session is, the only reader of pi's run state in Damocles (docs/invariants.md, "pi's run
 * lifecycle"). One per session: bound where the session is bound (`trackRunLifecycle`), disposed when it is let go.
 */
export interface RunLifecycle {
  readonly session: AgentSession;
  /** `start` until the run's agent loop starts, `run` until its `agent_end`, then `settle` until its `agent_settled`. */
  readonly phase: WindDownPhase;
  /** pi holds a run from `_startRun` until its `agent_settled` handlers start, so a prompt made now joins that run and needs a `streamingBehavior`. */
  readonly streaming: boolean;
  /** pi runs an ended run's `agent_settled` handlers, so a prompt made now is deferred until they return. */
  readonly settling: boolean;
  /** A message queued now still reaches the model: pi streams, or settles a run, after which it goes out on its own. */
  readonly mayQueue: boolean;
  /** pi has a run, its settle or a compaction under way, so nothing may rebuild the session's runtime. */
  readonly busy: boolean;
  /** Calls `listener` after each lifecycle event moved the phase. */
  onChange(listener: (event: AgentSessionEvent) => void): () => void;
  /** While `settling`, resolves at that run's `agent_settled`, as `signal` aborts or as the lifecycle is disposed; null otherwise. */
  untilSettled(signal?: AbortSignal): Promise<void> | null;
  /** Resolves at the `agent_settled` of the run pi has open now, or as the lifecycle is disposed; null when none is open. */
  untilRunEnds(): Promise<void> | null;
  /** Resolves once pi has no run open and has run the actions its last settle deferred, or as `signal` aborts; null when idle now. */
  untilIdle(signal?: AbortSignal): Promise<void> | null;
  dispose(): void;
}

const PHASE_AFTER: Partial<Record<AgentSessionEvent['type'], WindDownPhase>> = {
  agent_start: 'run',
  agent_end: 'settle',
  agent_settled: 'start',
};

const bound = new WeakMap<AgentSession, RunLifecycle>();

/** The lifecycle bound to `session`; a session nothing bound is a caller's bug, so it throws. */
export function runLifecycleOf(session: AgentSession): RunLifecycle {
  const lifecycle = bound.get(session);
  if (!lifecycle) throw new Error('No run lifecycle is bound to this pi session.');
  return lifecycle;
}

/** Resolves as `wait` settles or any of `signals` aborts. */
function until(wait: Promise<unknown>, signals: readonly (AbortSignal | undefined)[]): Promise<void> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      for (const signal of live) signal.removeEventListener('abort', done);
      resolve();
    };
    for (const signal of live) signal.addEventListener('abort', done, { once: true });
    void wait.then(done, done);
  });
}

export function trackRunLifecycle(session: AgentSession): RunLifecycle {
  if (bound.has(session)) throw new Error('This pi session already has a run lifecycle.');
  let stored: WindDownPhase = 'start';
  // pi resolves an idle wait made while a run is open only after that run's settle ran the actions it deferred (agent-session.js:695-706).
  let idleAfterSettle: Promise<void> | null = null;
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const disposed = new AbortController();
  const unsubscribe = session.subscribe((event) => {
    const next = PHASE_AFTER[event.type];
    if (next === undefined) return;
    stored = next;
    if (event.type === 'agent_end') {
      const idle = session.waitForIdle();
      idleAfterSettle = idle;
      void idle.then(() => {
        if (idleAfterSettle === idle) idleAfterSettle = null;
      });
    }
    for (const listener of [...listeners]) listener(event);
  });
  const onChange = (listener: (event: AgentSessionEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const nextSettled = (): Promise<void> => new Promise<void>((resolve) => {
    const off = onChange((event) => {
      if (event.type !== 'agent_settled') return;
      off();
      resolve();
    });
  });
  // pi turns `isStreaming` false as it starts the `agent_settled` handlers and publishes `agent_settled` after them (agent-session.js:685-690).
  const settlingNow = (): boolean => stored !== 'start' && !session.isStreaming;
  const lifecycle: RunLifecycle = {
    session,
    get phase() {
      // The `agent_start` handlers run inside the agent loop, before pi publishes the event (agent-session.js:752), and the loop runs only inside `_startRun`.
      return stored === 'start' && session.isStreaming && session.agent.state.isStreaming ? 'run' : stored;
    },
    get streaming() {
      return session.isStreaming;
    },
    get settling() {
      return settlingNow();
    },
    get mayQueue() {
      return session.isStreaming || settlingNow();
    },
    get busy() {
      return session.isStreaming || settlingNow() || session.isCompacting;
    },
    onChange,
    untilSettled: (signal) => {
      if (!settlingNow() || signal?.aborted || disposed.signal.aborted) return null;
      return until(nextSettled(), [signal, disposed.signal]);
    },
    untilRunEnds: () => {
      if ((!session.isStreaming && stored === 'start') || disposed.signal.aborted) return null;
      return until(nextSettled(), [disposed.signal]);
    },
    untilIdle: (signal) => {
      if ((!session.isStreaming && stored === 'start') || signal?.aborted || disposed.signal.aborted) return null;
      return (async () => {
        while (!signal?.aborted && !disposed.signal.aborted) {
          // pi's own idle wait covers a run's preparation, whose failure publishes no `agent_settled` (agent-session.js:1429-1435).
          if (session.isStreaming) await until(session.waitForIdle(), [signal, disposed.signal]);
          else if (stored !== 'start') await until(idleAfterSettle ?? nextSettled(), [signal, disposed.signal]);
          else return;
        }
      })();
    },
    dispose: () => {
      unsubscribe();
      disposed.abort();
      listeners.clear();
      if (bound.get(session) === lifecycle) bound.delete(session);
    },
  };
  bound.set(session, lifecycle);
  return lifecycle;
}
