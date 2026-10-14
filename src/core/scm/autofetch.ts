// Autofetch (D10; VS Code's extensions/git/src/autofetch.ts, MIT, see THIRD-PARTY-NOTICES.md): while it is on, the selected
// project's repositories fetch at once and then every period, one fetch per common dir, never prompting. A failure is logged
// once per common dir and distinct failure, until a fetch there succeeds or autofetch starts over, and a refused credential
// stops that common dir until the next start.
import { GitError } from './git-runner';
import { AUTHENTICATION_FAILED } from './sync';

// setTimeout overflows past 2^31 - 1 ms, so the schema's maximum of a day is enforced here too
const DEFAULT_PERIOD_SECONDS = 180;
const MAX_PERIOD_SECONDS = 86_400;

export function autofetchPeriodSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, 1), MAX_PERIOD_SECONDS) : DEFAULT_PERIOD_SECONDS;
}

// curl reports how long a refused connection took, so two attempts that failed alike would otherwise differ
function sameFailureKey(text: string): string {
  return text.replace(/ after \d+ ms\b/g, '');
}

export interface AutofetchTarget {
  // the common dir, which linked worktrees share
  readonly key: string;
  // asked right before each fetch, since an interactive operation may start during the round's earlier fetches
  idle(): boolean;
  fetch(signal: AbortSignal): Promise<void>;
}

export interface AutofetchDeps {
  readonly enabled: () => boolean;
  readonly periodMs: () => number;
  // the selected project's repositories, one per common dir, read at each round
  readonly targets: () => readonly AutofetchTarget[];
  readonly log: (line: string) => void;
  readonly describe: (err: unknown) => string;
}

export class Autofetcher {
  private readonly deps: AutofetchDeps;
  private timer: NodeJS.Timeout | undefined;
  private round: AbortController | undefined;
  // the common dir the round fetches now, and that fetch, settled whatever its outcome
  private running: { readonly key: string; readonly settled: Promise<void> } | undefined;
  private generation = 0;
  // the failure last logged per common dir; a success clears it
  private readonly failures = new Map<string, string>();
  // common dirs whose credentials git refused; nothing fetches them until start()
  private readonly refused = new Set<string>();

  constructor(deps: AutofetchDeps) {
    this.deps = deps;
  }

  /** Starts over, as a project switch or a setting change does: one round now, then every period. */
  start(): void {
    this.stop();
    this.failures.clear();
    this.refused.clear();
    if (this.deps.enabled()) this.schedule(0);
  }

  /** One round now, as if the period had elapsed; the failures logged and the refused credentials stay as they are. */
  runNow(): void {
    this.stop();
    if (this.deps.enabled()) this.schedule(0);
  }

  /** Stops the timer and kills a running round's fetches. */
  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.round?.abort();
    this.round = undefined;
    this.running = undefined;
  }

  /** Kills the round's fetch of one common dir, which an interactive remote operation there replaces; resolves once it ended. */
  async yieldTo(key: string): Promise<void> {
    const running = this.running;
    if (running?.key !== key) return;
    this.round?.abort();
    await running.settled;
  }

  private schedule(delayMs: number): void {
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runRound(generation);
    }, delayMs);
  }

  private async runRound(generation: number): Promise<void> {
    for (const target of this.deps.targets()) {
      if (generation !== this.generation) return;
      if (this.refused.has(target.key) || !target.idle()) continue;
      const round = new AbortController();
      this.round = round;
      const fetched = target.fetch(round.signal);
      this.running = { key: target.key, settled: fetched.then(() => undefined, () => undefined) };
      try {
        await fetched;
        this.failures.delete(target.key);
      } catch (err) {
        if (generation !== this.generation || round.signal.aborted) continue;
        const text = this.deps.describe(err);
        const failure = sameFailureKey(text);
        if (this.failures.get(target.key) !== failure) {
          this.failures.set(target.key, failure);
          this.deps.log(`[scm] autofetch failed: ${text}`);
        }
        // stderr, since the described text keeps only git's error and fatal lines and drops ssh's refusal
        if (AUTHENTICATION_FAILED.test(err instanceof GitError ? err.stderr : text)) this.refused.add(target.key);
      } finally {
        if (this.round === round) {
          this.running = undefined;
          this.round = undefined;
        }
      }
    }
    if (generation === this.generation && this.deps.enabled()) this.schedule(this.deps.periodMs());
  }
}
