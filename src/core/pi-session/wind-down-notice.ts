import type { AgentWindDown } from '../../shared/types/wind-down';
import type { RunLifecycle } from './run-lifecycle';

/**
 * How long a stopped run may wind down before its card says what it waits for. A wind-down nothing holds (the aborted
 * message, the turn-stopped records, a hook's process tree killed by the stop) ends well within it.
 */
export const WIND_DOWN_NOTICE_MS = 3_000;

export interface WindDownNotice {
  /** The owner stopped waiting for the run: the notice is cancelled, and cleared if it showed. */
  end(): void;
  /**
   * Resolves once pi has finished the run it had open when `stop` fired: at its `agent_settled`, which pi publishes after
   * the handlers and before it runs the actions they deferred (agent-session.js:689-699), or at once when none was open.
   */
  readonly runSettled: Promise<void>;
}

// `builtin:<name>` and `<inline:...>` name no file (`source-info.js:14-16` in pi-coding-agent 1.4.0).
const loadedFromFile = (extensionPath: string): boolean => !extensionPath.startsWith('builtin:') && !extensionPath.startsWith('<');

function windDownOf(run: RunLifecycle, skipsBeforeSettle: boolean): AgentWindDown {
  const now = run.phase;
  let events: string[] = [];
  if (now === 'start') events = ['input', 'before_agent_start'];
  else if (now === 'settle') events = skipsBeforeSettle || run.settling ? ['agent_settled'] : ['agent_before_settle', 'agent_settled'];
  const extensions = run.session.resourceLoader.getExtensions().extensions
    .filter((extension) => loadedFromFile(extension.path))
    .filter((extension) => now === 'run' || events.some((event) => (extension.handlers.get(event)?.length ?? 0) > 0))
    .map((extension) => extension.path);
  return { phase: now, events, extensions };
}

const sameWindDown = (a: AgentWindDown, b: AgentWindDown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Once `stop` fires, waits `WIND_DOWN_NOTICE_MS` and then publishes what the run's wind-down waits for, again at each
 * lifecycle event until the owner calls `end`. Display only: it never changes how the owner waits.
 */
export function noticeWindDown(run: RunLifecycle, stop: AbortSignal, publish: (windDown: AgentWindDown | null) => void): WindDownNotice {
  let skipsBeforeSettle = false;
  let shown: AgentWindDown | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let settleRun!: () => void;
  const runSettled = new Promise<void>((resolve) => { settleRun = resolve; });

  // A timer or a pi listener must not throw: the notice is display only.
  const send = (windDown: AgentWindDown | null): void => {
    try {
      publish(windDown);
    } catch (err) {
      console.error('[WindDownNotice] publishing a wind-down failed:', err);
    }
  };
  const show = (): void => {
    let next: AgentWindDown;
    try {
      next = windDownOf(run, skipsBeforeSettle);
    } catch (err) {
      console.error('[WindDownNotice] reading a wind-down failed:', err);
      return;
    }
    if (shown && sameWindDown(shown, next)) return;
    shown = next;
    send(next);
  };

  const unsubscribe = run.onChange((event) => {
    if (!shown) return;
    // pi resolves the settled run's prompt in microtasks after this event, so only a wait that outlasts them shows `start`.
    if (event.type === 'agent_settled') timer = setTimeout(show, 0);
    else show();
  });
  const onStop = (): void => {
    // A run aborted before it ended skips its `agent_before_settle` handlers (agent-session.js:1450, :1457).
    skipsBeforeSettle = run.phase !== 'settle';
    const runEnds = run.untilRunEnds();
    if (runEnds) void runEnds.then(settleRun);
    else settleRun();
    timer = setTimeout(show, WIND_DOWN_NOTICE_MS);
  };
  if (stop.aborted) onStop();
  else stop.addEventListener('abort', onStop, { once: true });

  return {
    runSettled,
    end: () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      stop.removeEventListener('abort', onStop);
      unsubscribe();
      if (shown) send(null);
    },
  };
}
