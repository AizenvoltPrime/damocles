/** A selection's turn: `current` tells, after each await, whether a later selection overtook it; `settle` ends it. */
export interface SelectionTurn {
  readonly current: () => boolean;
  readonly settle: () => void;
}

/** The user's selections in order: one a later selection overtook while it awaited does nothing more. */
export class SelectionTurns {
  private latest = 0;
  private settled = 0;

  begin(): SelectionTurn {
    const turn = ++this.latest;
    return {
      current: () => turn === this.latest,
      settle: () => { if (turn === this.latest) this.settled = turn; },
    };
  }

  /** A re-check no selection asked for: none while a selection is in flight, and overtaken by any selection that starts. */
  join(): (() => boolean) | undefined {
    if (this.settled !== this.latest) return undefined;
    const turn = this.latest;
    return () => turn === this.latest;
  }
}
