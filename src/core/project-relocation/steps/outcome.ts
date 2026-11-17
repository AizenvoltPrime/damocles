import type { Coded, RelocationWait, WorktreeRepairFailure } from '../types';

/** How a step ended: done, waiting on something outside the run (retried at the next core start), or paused with a reason. */
export type StepOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'waiting'; readonly failure: RelocationWait; readonly repairFailures?: readonly WorktreeRepairFailure[] }
  | { readonly kind: 'paused'; readonly failure: Coded };

export const STEP_DONE: StepOutcome = { kind: 'done' };

/** Thrown inside a step to pause the relocation with a coded reason. */
export class RelocationPause extends Error {
  readonly failure: Coded;

  constructor(failure: Coded) {
    super(`relocation paused: ${failure.code}`);
    this.name = 'RelocationPause';
    this.failure = failure;
  }
}

/** The pause a step's failure makes: its own code, else `io` with the path and errno a Node error carries. */
export function pausedBy(err: unknown): StepOutcome {
  if (err instanceof RelocationPause) return { kind: 'paused', failure: err.failure };
  const errno = err as NodeJS.ErrnoException | undefined;
  return { kind: 'paused', failure: { code: 'io', params: { path: errno?.path ?? '', errno: errno?.code ?? 'unknown' } } };
}
