import type { Agent, AgentTurnContext, AgentTurnDecision } from '@earendil-works/pi-agent-core';
import { log } from '../logger';

/**
 * A Damocles opinion about whether pi should end the run after the completed turn. `undefined` is the
 * only way to say nothing: `{ action: 'continue' }` would override another decider's `end`.
 */
export type TurnDecider = (
  turn: AgentTurnContext,
  signal?: AbortSignal,
) => AgentTurnDecision | undefined | Promise<AgentTurnDecision | undefined>;

/** Graceful budget stop, installed per `bindSession` (US-008). */
export const BUDGET_STOP_HOOK: unique symbol = Symbol('damocles.budgetStop');

/** Team terminal tools (`team_standby`, `team_report_complete`), installed per agent run (US-024b). */
export const TEAM_TERMINAL_HOOK: unique symbol = Symbol('damocles.teamTerminalTool');

interface DeciderRegistry {
  /** pi's own `finishTurn`, captured once at first install. */
  prior: Agent['finishTurn'];
  deciders: Map<symbol, TurnDecider>;
}

const registries = new WeakMap<Agent, DeciderRegistry>();

/**
 * Register `decide` under `key` on `agent`, installing exactly one Damocles wrapper per agent.
 *
 * Installed at call time rather than through the session factory, with `prior` captured then, because
 * pi's `AgentSession._installAgentBoundaryHooks` assigns `agent.finishTurn` from the constructor and
 * buries whatever layer was present at construction. Keyed deciders in one registry keep a second
 * install idempotent instead of stacking a layer per call.
 *
 * Nothing may reassign `agent.finishTurn` after this has run on that agent: "already installed" is read
 * from the registry alone, so a displaced wrapper would take later registrations into an unreachable map.
 */
export function installTurnDecider(agent: Agent, key: symbol, decide: TurnDecider): void {
  const existing = registries.get(agent);
  if (existing) {
    existing.deciders.set(key, decide);
    return;
  }

  const registry: DeciderRegistry = { prior: agent.finishTurn, deciders: new Map([[key, decide]]) };
  registries.set(agent, registry);

  agent.finishTurn = async (turn, signal) => {
    // pi's AgentSession owns this field and dispatches the extension `turn_end` boundary through it
    // (`agent-session.ts:675-685`), so the captured hook runs on every turn and is never short-circuited:
    // skipping it silently destroys the checkpoint `turn_end` handler with no type error. It stays
    // unguarded below: a throw from pi's own boundary hook is a real checkpointing failure to surface.
    const decisions: Array<AgentTurnDecision | undefined> = [
      (await registry.prior?.(turn, signal)) as AgentTurnDecision | undefined,
    ];
    // Every decider runs even once one has answered `end`, because a decider may owe the run a side
    // effect. A throwing one holds no opinion instead: pi's call site is a bare await, so an escaping
    // throw makes pi replace the completed turn's outcome with a synthetic error and re-emit `turn_end`.
    for (const [deciderKey, decider] of [...registry.deciders]) {
      try {
        decisions.push(await decider(turn, signal));
      } catch (err) {
        log('[TurnDecider] %s failed: %O', String(deciderKey), err);
      }
    }
    // `end` wins over `continue`, matching pi's own precedence: a budget stop is a hard limit the user set.
    if (decisions.some((decision) => decision?.action === 'end')) return { action: 'end' };
    if (decisions.some((decision) => decision?.action === 'continue')) return { action: 'continue' };
    return undefined;
  };
}
