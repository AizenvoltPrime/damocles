// The keep-changes banner (docs/invariants.md "Desktop themes"): one at most. An agent's on-the-fly change core applied starts
// a KEEP_CHANGES_MS countdown; any later change while it runs, whoever made it, restarts it; Keep clears core's mark, Revert or
// the timeout undoes every change it covers, and every waiting tool call gets the end.
import { KEEP_CHANGES_MS, type KeepChangesEndedBy, type KeepChangesState } from '../../../shared/themes/agent';
import type { ThemeHistoryChange } from '../../../shared/themes/changes';
import { shownChange, shownStoredName } from './theme-files';

// How long the banner says Kept or Reverted after the end.
export const KEEP_RESULT_LINGER_MS = 5_000;

/** The banner's state as the shell shows it: every built-in it names by id in the UI's language. */
export function shownKeepChanges(state: KeepChangesState, localization: { t(message: string): string }): KeepChangesState {
  return {
    ...state,
    change: shownChange(state.change, localization),
    ...(state.previousName !== undefined ? { previousName: shownStoredName(state.previousId, state.previousName, localization) } : {}),
  };
}

export type KeepOutcome = 'kept' | 'reverted';

export interface KeepChangesAsk {
  // the countdown's entry, the mark's
  readonly entryId: string;
  // the chat that made the change; undefined: the user
  readonly chatId?: string;
  // undefined: the chat has no title yet
  readonly chatTitle?: string;
  readonly change: ThemeHistoryChange;
  readonly previousName?: string;
  readonly previousId?: string;
}

export interface KeepChangesDeps {
  // core's themes.keep
  keep(entryId: string): Promise<void>;
  // core's revert of the countdown that this entry starts; false when core undid nothing, since another change settled it first
  revert(entryId: string): Promise<boolean>;
  // the shell's banner, and main's hold of the pre-change palette on trusted UI
  publish(state: KeepChangesState | undefined): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log(line: string): void;
}

interface Countdown {
  entryId: string;
  state: KeepChangesState;
  // the chat id of every change it covers, '' for the user's
  readonly actors: Set<string>;
  timer: unknown;
  readonly waiters: Set<(outcome: KeepOutcome) => void>;
  // an answer of this countdown went to an engine, so files that changed while none ran may be that answer's doing
  asked: boolean;
}

export class KeepChanges {
  private current: Countdown | undefined;
  private linger: unknown;
  // this computer's engine ended and none started since: nothing can keep or revert, so no timer runs
  private engineDown = false;
  private readonly deps: KeepChangesDeps;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(deps: KeepChangesDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The countdown runs: F6 reaches the banner, and trusted UI keeps the pre-change palette. */
  counting(): boolean {
    return this.current !== undefined;
  }

  /** The entry the running countdown settles. */
  entryId(): string | undefined {
    return this.current?.entryId;
  }

  /**
   * Starts or restarts the countdown for an on-the-fly `ask`, and resolves with its end; `signal` lets go of this wait only.
   * Core settles a countdown before it starts another (themes.pendingSettled), so another entry here ends the earlier as kept.
   */
  applied(ask: KeepChangesAsk, signal?: AbortSignal): Promise<KeepOutcome> {
    const countdown = this.restart(ask);
    return new Promise<KeepOutcome>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter = (outcome: KeepOutcome): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => {
        countdown.waiters.delete(waiter);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      countdown.waiters.add(waiter);
    });
  }

  /** A change that is not on the fly joined the countdown core marks, the user's or a chat's: it restarts, and no call waits. */
  extended(ask: KeepChangesAsk): void {
    this.restart(ask);
  }

  // The countdown of `ask`, started or restarted for KEEP_CHANGES_MS; it keeps the look its first change replaced.
  private restart(ask: KeepChangesAsk): Countdown {
    if (this.current && this.current.entryId !== ask.entryId) this.finish('kept');
    const running = this.current;
    const countdown = running ?? { entryId: ask.entryId, state: undefined as unknown as KeepChangesState, actors: new Set<string>(), timer: undefined, waiters: new Set(), asked: false };
    countdown.actors.add(ask.chatId ?? '');
    const several = countdown.actors.size > 1;
    const { previousName, previousId } = running ? running.state : ask;
    this.clearTimer(countdown.timer);
    this.clearTimer(this.linger);
    countdown.state = {
      phase: 'counting',
      endsAt: this.now() + KEEP_CHANGES_MS,
      durationMs: KEEP_CHANGES_MS,
      ...(!several && ask.chatTitle !== undefined ? { chatTitle: ask.chatTitle } : {}),
      change: ask.change,
      ...(previousName !== undefined ? { previousName } : {}),
      ...(previousId !== undefined ? { previousId } : {}),
      changeCount: running ? running.state.changeCount + 1 : 1,
      ...(several ? { several: true as const } : {}),
    };
    countdown.timer = this.timeout();
    this.current = countdown;
    this.deps.publish(countdown.state);
    return countdown;
  }

  /** The banner's Keep. */
  keep(): Promise<void> {
    return this.pressed('kept');
  }

  /** The banner's Revert. */
  revert(): Promise<void> {
    return this.pressed('reverted');
  }

  // A press has a caller to tell of a failure; the timeout has none, and end() has logged it and set the next try.
  private async pressed(outcome: KeepOutcome): Promise<void> {
    const failed = await this.end(outcome, 'user');
    if (failed) throw failed.error;
  }

  private timeout(): unknown {
    return this.setTimer(() => void this.end('reverted', 'timeout'), KEEP_CHANGES_MS);
  }

  /**
   * Core ended the countdown itself and cleared the mark. `by` is who core's word names: the engine's start, or the user,
   * whose Undo took back the countdown's first change; absent for a change the banner did not make that came first.
   */
  settled(entryId: string, outcome: KeepOutcome, by?: KeepChangesEndedBy): void {
    if (this.current?.entryId === entryId) this.finish(outcome, by);
  }

  /** This computer's engine ended: the countdown stops and says so, since its timeout could only fail against no engine. */
  coreEnded(): void {
    this.engineDown = true;
    if (this.current) this.again(this.current);
  }

  // The countdown takes answers again: it counts from the start, or with no engine waits for one to start (coreStarted).
  private again(countdown: Countdown): void {
    const { ending: _ending, engineDown: _engineDown, ...state } = countdown.state;
    this.clearTimer(countdown.timer);
    countdown.state = this.engineDown ? { ...state, engineDown: true } : { ...state, endsAt: this.now() + KEEP_CHANGES_MS };
    countdown.timer = this.engineDown ? undefined : this.timeout();
    this.deps.publish(countdown.state);
  }

  /**
   * An engine started. `stands` says how the countdown the ended engine left stands now (readCountdownEnd): still marked,
   * it counts again from the start; otherwise it ended while no engine ran, as the new engine's revert at its start.
   */
  coreStarted(stands: 'marked' | 'kept' | 'reverted'): void {
    this.engineDown = false;
    const countdown = this.current;
    if (!countdown) return;
    if (stands !== 'marked') {
      // Only an engine's start or an answer that was on its way changes the files while no engine runs. A change still on
      // disk may be either's doing, which the files do not tell apart.
      this.finish(stands, stands === 'reverted' && !countdown.asked ? 'engineStart' : undefined);
      return;
    }
    this.again(countdown);
  }

  dispose(): void {
    if (this.current) this.clearTimer(this.current.timer);
    this.clearTimer(this.linger);
  }

  // The user's answer or the timeout: core first, so a revert that fails leaves the countdown running for another try.
  // Never rejects: a failure is logged, the next try is set, and it is the answer.
  private async end(outcome: KeepOutcome, by: KeepChangesEndedBy): Promise<{ readonly error: unknown } | undefined> {
    const countdown = this.current;
    if (!countdown || countdown.state.ending) return undefined;
    this.clearTimer(countdown.timer);
    countdown.state = { ...countdown.state, ending: outcome };
    countdown.asked = true;
    this.deps.publish(countdown.state);
    let ended: { readonly outcome: KeepOutcome; readonly by?: KeepChangesEndedBy } = { outcome, by };
    try {
      if (outcome === 'kept') await this.deps.keep(countdown.entryId);
      // core undid nothing: its themes.pendingSettled, sent before this answer, ended the countdown, else the change stays,
      // and whatever cleared the mark kept it, not this answer
      else if (!(await this.deps.revert(countdown.entryId))) ended = { outcome: 'kept' };
    } catch (err) {
      this.deps.log(`[themes] the keep-changes banner could not ${outcome === 'kept' ? 'keep' : 'revert'} the change: ${err instanceof Error ? err.message : String(err)}`);
      if (this.current === countdown) this.again(countdown);
      return { error: err };
    }
    if (this.current === countdown) this.finish(ended.outcome, ended.by);
    return undefined;
  }

  private finish(outcome: KeepOutcome, by?: KeepChangesEndedBy): void {
    const countdown = this.current;
    if (!countdown) return;
    this.current = undefined;
    this.clearTimer(countdown.timer);
    const { ending: _ending, engineDown: _engineDown, ...state } = countdown.state;
    const ended: KeepChangesState = { ...state, phase: outcome, endsAt: Math.min(state.endsAt, this.now()), ...(by !== undefined ? { endedBy: by } : {}) };
    this.deps.publish(ended);
    for (const waiter of [...countdown.waiters]) waiter(outcome);
    countdown.waiters.clear();
    this.clearTimer(this.linger);
    this.linger = this.setTimer(() => {
      this.linger = undefined;
      if (!this.current) this.deps.publish(undefined);
    }, KEEP_RESULT_LINGER_MS);
  }
}
