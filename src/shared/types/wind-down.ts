/**
 * What a stopped run, the main chat's or a nested agent's, still waits for, as its owner reads it from pi's public events
 * (docs/invariants.md, "Teams and subagents"). `start`: pi has not started the run's agent loop. `run`: the loop has not ended, so its tool
 * calls and event handlers hold the stop's abort signal. `settle`: the loop ended and pi awaits its settle handlers.
 */
export type WindDownPhase = 'start' | 'run' | 'settle';

/** The hooks file that set a hook: `~/.damocles/hooks.json` (`user`) or the project's `.damocles/hooks.json` (`project`). */
export type HookScope = 'user' | 'project';

/** A configured end-of-turn hook still running. `label` names its script or program and never carries its arguments. */
export interface WindDownHook {
  label: string;
  scope: HookScope;
}

export interface AgentWindDown {
  phase: WindDownPhase;
  /** The pi events whose extension handlers pi may be awaiting, none of which gets an abort signal; empty for `run`. */
  events: string[];
  /** Paths of the pi extensions loaded from files that handle one of `events` in `settle`; empty in `start` and `run`. */
  extensions: string[];
  /** The configured Stop and SubagentStop hooks the run's `agent_settled` handlers still wait for; absent when none runs. */
  hooks?: WindDownHook[];
}
