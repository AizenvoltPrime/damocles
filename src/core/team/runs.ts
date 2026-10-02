import type { TeamRunSummary } from '../../shared/types/team';
import { emptyAgentUsage, type AgentUsageTotals } from '../../shared/usage-accounting';
import { isEffortBadgeLevel, type EffortBadgeLevel } from '../../shared/effort-badge';
import { stopStopwatch, type Stopwatch } from '../../shared/team-stopwatch';

/** The work totals a `team-completed` or `team-cancelled` entry records for its run. */
export type TeamRunTotals = { toolCount: number } & AgentUsageTotals;

/** A run's totals as read back from a log entry. */
type ReadRunTotals = Pick<TeamRunSummary, 'toolCount' | 'usage' | 'legacyTokens'>;

type EndedStatus = Exclude<TeamRunSummary['status'], 'running'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isEndedStatus = (v: unknown): v is EndedStatus => v === 'completed' || v === 'failed' || v === 'cancelled';

const TOKEN_KINDS = ['totalInputTokens', 'totalOutputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

/**
 * An entry's run totals. A log written before the token kinds were recorded carries `tokens`, input plus
 * output only, which is kept apart as `legacyTokens` rather than read as a total of every kind.
 */
function readRunTotals(value: unknown): ReadRunTotals | null {
  if (!isRecord(value)) return null;
  const { toolCount, costUsd } = value;
  if (!isCount(toolCount) || !isAmount(costUsd)) return null;
  const usage = { ...emptyAgentUsage(), costUsd };
  if (TOKEN_KINDS.every((key) => isCount(value[key]))) {
    for (const key of TOKEN_KINDS) usage[key] = value[key] as number;
    return { toolCount, usage };
  }
  const tokens = value['tokens'];
  return isCount(tokens) ? { toolCount, usage, legacyTokens: tokens } : null;
}

/**
 * A team's runs, rebuilt from its event log entries fed in order. The log is untrusted, so a malformed
 * field adds nothing. A run's totals are the ones its `team-completed` entry recorded, else the ones
 * its `team-cancelled` entry recorded, else the sum of its members' `agent-completed` entries. A run
 * with no `team-completed` was cut short by a reload, so it ends cancelled at the log's last entry.
 * It also holds each member's effort and active time, per-attempt work fields, so every log reader applies
 * one rule. A member's stopwatch opens at its `agent-spawned` (a new attempt, from zero) or `agent-resumed`
 * entry and closes at its `agent-completed` or the run's `team-completed`; a run cut short closes it at the
 * entry before the next run starts, or at the log's last entry. An `agent-completed` stamped with another
 * run's `toolUseId` counts toward nothing in the open run.
 */
export class TeamRunLog {
  private readonly ended: TeamRunSummary[] = [];
  private open: TeamRunSummary | null = null;
  private openCancelTotals: ReadRunTotals | null = null;
  // Each member's logged tool calls in its current attempt, since `agent-completed` carries that running count.
  private readonly attemptToolCounts = new Map<string, number>();
  // By agentId: a spawn starts an attempt with no effort, and only that attempt's own sessions set it.
  private readonly efforts = new Map<string, { attempt: number; effort: EffortBadgeLevel | null }>();
  // By agentId, with the same attempt rule as `efforts`.
  private readonly stopwatches = new Map<string, { attempt: number; stopwatch: Stopwatch }>();
  private lastTime: number | null = null;

  add(entry: unknown): void {
    if (!isRecord(entry)) return;
    const stamp = entry['timestamp'];
    const time = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    const timed = Number.isFinite(time);
    const name = entry['name'];

    switch (entry['type']) {
      case 'team-created':
      case 'team-resumed': {
        const toolUseId = entry['toolUseId'];
        if (typeof toolUseId !== 'string' || !timed) break;
        this.closeOpenRun();
        if (this.lastTime !== null) this.stopAll(this.lastTime);
        this.open = { toolUseId, status: 'running', startTime: time, endTime: null, toolCount: 0, usage: emptyAgentUsage() };
        break;
      }
      case 'team-cancelled':
        if (this.open) this.openCancelTotals = readRunTotals(entry['run']) ?? this.openCancelTotals;
        break;
      case 'agent-spawned': {
        if (typeof name === 'string') this.attemptToolCounts.set(name, 0);
        const agentId = entry['agentId'];
        // A log written before the attempt counter existed carries none, and its spawns are the first attempt.
        const attempt = isCount(entry['attempt']) ? entry['attempt'] : 0;
        if (typeof agentId === 'string') this.efforts.set(agentId, { attempt, effort: null });
        if (typeof agentId === 'string' && timed) this.stopwatches.set(agentId, { attempt, stopwatch: { activeMs: 0, runningSince: time } });
        break;
      }
      case 'agent-resumed': {
        const agentId = entry['agentId'];
        const current = typeof agentId === 'string' ? this.stopwatches.get(agentId) : undefined;
        const attempt = isCount(entry['attempt']) ? entry['attempt'] : 0;
        if (!current || !timed || attempt !== current.attempt || current.stopwatch.runningSince !== null) break;
        current.stopwatch = { ...current.stopwatch, runningSince: time };
        break;
      }
      case 'agent-session-started': {
        const agentId = entry['agentId'];
        const current = typeof agentId === 'string' ? this.efforts.get(agentId) : undefined;
        // A redispatch may have started a newer attempt before an older attempt's session opened.
        if (!current || entry['attempt'] !== current.attempt) break;
        current.effort = isEffortBadgeLevel(entry['effort']) ? entry['effort'] : null;
        break;
      }
      case 'agent-completed': {
        // A late settle of an earlier run belongs to that run; an entry without the field predates it.
        const runId = entry['toolUseId'];
        if (typeof runId === 'string' && runId !== this.open?.toolUseId) break;
        const agentId = entry['agentId'];
        const current = typeof agentId === 'string' ? this.stopwatches.get(agentId) : undefined;
        if (current && timed) current.stopwatch = stopStopwatch(current.stopwatch, time);
        if (typeof name !== 'string') break;
        const count = entry['toolCallCount'];
        if (isCount(count)) {
          if (this.open) this.open.toolCount += Math.max(0, count - (this.attemptToolCounts.get(name) ?? 0));
          this.attemptToolCounts.set(name, count);
        }
        if (this.open) {
          const usage = this.open.usage;
          for (const key of TOKEN_KINDS) {
            const tokens = entry[key];
            if (isCount(tokens)) usage[key] += tokens;
          }
          const cost = entry['costUsd'];
          if (isAmount(cost)) usage.costUsd += cost;
        }
        break;
      }
      case 'team-completed': {
        const status = entry['status'];
        if (timed) this.stopAll(time);
        if (!this.open || !timed || !isEndedStatus(status)) break;
        this.ended.push({ ...this.open, ...(readRunTotals(entry['run']) ?? this.openCancelTotals), status, endTime: time });
        this.open = null;
        this.openCancelTotals = null;
        break;
      }
      default:
        break;
    }
    if (timed) this.lastTime = time;
  }

  /** The member's effort in its latest attempt; null before that attempt's session started or in a log that predates the entry. */
  memberEffort(agentId: string): EffortBadgeLevel | null {
    return this.efforts.get(agentId)?.effort ?? null;
  }

  /** Every member's non-null effort, by agentId. */
  memberEfforts(): Map<string, EffortBadgeLevel> {
    const out = new Map<string, EffortBadgeLevel>();
    for (const [agentId, { effort }] of this.efforts) if (effort) out.set(agentId, effort);
    return out;
  }

  /** The member's active time in its latest attempt; a stopwatch still open closes at the log's last entry. */
  memberActiveMs(agentId: string): number {
    const current = this.stopwatches.get(agentId);
    return current ? this.closedAtEnd(current.stopwatch) : 0;
  }

  /** Every member's active time in its latest attempt, by agentId. */
  memberActiveTimes(): Map<string, number> {
    return new Map([...this.stopwatches].map(([agentId, { stopwatch }]) => [agentId, this.closedAtEnd(stopwatch)]));
  }

  /** Every run so far, each ended; an open one reads as cut short. */
  runs(): TeamRunSummary[] {
    return this.open ? [...this.ended, this.cutShort(this.open)] : [...this.ended];
  }

  private closedAtEnd(stopwatch: Stopwatch): number {
    return stopStopwatch(stopwatch, this.lastTime ?? 0).activeMs;
  }

  private stopAll(at: number): void {
    for (const current of this.stopwatches.values()) current.stopwatch = stopStopwatch(current.stopwatch, at);
  }

  private closeOpenRun(): void {
    if (this.open) this.ended.push(this.cutShort(this.open));
    this.open = null;
    this.openCancelTotals = null;
  }

  private cutShort(run: TeamRunSummary): TeamRunSummary {
    return { ...run, ...this.openCancelTotals, status: 'cancelled', endTime: this.lastTime ?? run.startTime };
  }
}
