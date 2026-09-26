/**
 * The one billing rule every Damocles usage figure applies. It mirrors pi's `AgentSession.getSessionStats()`
 * (pi-coding-agent `core/agent-session.ts`), so a live figure read from pi and a figure rebuilt from a session
 * file agree. Pure and structural: the webview bundle and the stats worker import it, so it depends on
 * nothing from pi, `vscode` or Node. Formulas: `docs/invariants.md`, "Usage accounting".
 */

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** pi's `Usage`, as read off disk: every field may be missing or malformed. */
export interface EntryUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cacheWrite1h?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  cost?: Partial<Record<keyof UsageCost, unknown>> | null;
}

export interface AccountingEntry {
  type?: unknown;
  timestamp?: unknown;
  usage?: EntryUsage | null;
  message?: { role?: unknown; usage?: EntryUsage | null } | null;
}

/** A normalized usage record: uncached input, output, cache read and write, and the recorded cost. */
export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  cost: UsageCost;
}

/** pi's `getSessionStats()` totals shape. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** The usage counters an agent or a conversation reports. `totalInputTokens` is uncached input. */
export interface AgentUsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function normalize(u: EntryUsage): NormalizedUsage {
  const c = u.cost ?? {};
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    cacheWrite1h: num(u.cacheWrite1h),
    reasoning: num(u.reasoning),
    cost: { input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite), total: num(c.total) },
  };
}

const isUsage = (u: unknown): u is EntryUsage => typeof u === 'object' && u !== null;

/**
 * The billed usage an entry carries, or undefined when pi's session total does not count it. Counted:
 * every assistant message whatever its stop reason, a `toolResult` message that carries usage, `usage`
 * entries (the cache warmer's `cache_warm`), and compaction and branch summaries that carry usage.
 */
export function usageOfEntry(entry: AccountingEntry): NormalizedUsage | undefined {
  if (entry.type === 'usage') return isUsage(entry.usage) ? normalize(entry.usage) : undefined;
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return isUsage(entry.usage) ? normalize(entry.usage) : undefined;
  if (entry.type !== 'message' || !entry.message) return undefined;
  const role = entry.message.role;
  if (role !== 'assistant' && role !== 'toolResult') return undefined;
  return isUsage(entry.message.usage) ? normalize(entry.message.usage) : undefined;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Sum every counted entry, in pi's `getSessionStats()` shape. */
export function sumUsage(entries: Iterable<AccountingEntry>, include: (entry: AccountingEntry) => boolean = () => true): UsageTotals {
  const totals = emptyUsageTotals();
  for (const entry of entries) {
    if (!include(entry)) continue;
    const u = usageOfEntry(entry);
    if (!u) continue;
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    totals.cost += u.cost.total;
  }
  return totals;
}

/** `a - b`, clamped at zero per field so a rounding wobble never shows a negative figure. */
export function subtractUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    cost: Math.max(0, a.cost - b.cost),
  };
}

export function toAgentUsage(t: UsageTotals): AgentUsageTotals {
  return { totalInputTokens: t.input, totalOutputTokens: t.output, cacheReadTokens: t.cacheRead, cacheCreationTokens: t.cacheWrite, costUsd: t.cost };
}

/** One entry's usage in the agent counters, its cost being the recorded total. */
export function agentUsageOf(u: NormalizedUsage): AgentUsageTotals {
  return { totalInputTokens: u.input, totalOutputTokens: u.output, cacheReadTokens: u.cacheRead, cacheCreationTokens: u.cacheWrite, costUsd: u.cost.total };
}

export function emptyAgentUsage(): AgentUsageTotals {
  return { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

export function addAgentUsage(a: AgentUsageTotals, b: AgentUsageTotals): AgentUsageTotals {
  return {
    totalInputTokens: a.totalInputTokens + b.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens + b.totalOutputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** `a - b`, clamped at zero per field like `subtractUsage`. */
export function subtractAgentUsage(a: AgentUsageTotals, b: AgentUsageTotals): AgentUsageTotals {
  return {
    totalInputTokens: Math.max(0, a.totalInputTokens - b.totalInputTokens),
    totalOutputTokens: Math.max(0, a.totalOutputTokens - b.totalOutputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheCreationTokens: Math.max(0, a.cacheCreationTokens - b.cacheCreationTokens),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
  };
}

/** Every prompt token the model read: uncached input plus cache read and cache write. */
export function promptTokens(u: AgentUsageTotals): number {
  return u.totalInputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** Total tokens, pi's `totalTokens`: input + output + cache read + cache write. */
export function agentTotalTokens(u: AgentUsageTotals): number {
  return promptTokens(u) + u.totalOutputTokens;
}

/** `cacheRead / (input + cacheRead + cacheWrite)`, or null when no prompt token was read. */
export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const denominator = input + cacheRead + cacheWrite;
  return denominator > 0 ? cacheRead / denominator : null;
}

export function agentCacheHitRate(u: AgentUsageTotals): number | null {
  return cacheHitRate(u.totalInputTokens, u.cacheReadTokens, u.cacheCreationTokens);
}

/** `isUnpriced` for a sum given as its recorded cost and its token count. */
export function totalUnpriced(cost: number, tokens: number): boolean {
  return cost === 0 && tokens > 0;
}

/** `isUnpriced` for a summed total: tokens were billed and the recorded cost is zero. */
export function agentUsageUnpriced(u: AgentUsageTotals): boolean {
  return totalUnpriced(u.costUsd, agentTotalTokens(u));
}

/** Whether a usage record bills anything. Never trust `totalTokens`: a provider may leave it at 0 while reporting tokens. */
export function carriesUsage(u: EntryUsage): boolean {
  const n = normalize(u);
  return n.input + n.output + n.cacheRead + n.cacheWrite > 0 || n.cost.total > 0;
}

/** Tokens were billed but pi had no price for the model, so the recorded cost is zero. */
export function isUnpriced(u: NormalizedUsage): boolean {
  return u.cost.total === 0 && u.input + u.output + u.cacheRead + u.cacheWrite > 0;
}

/**
 * What the cached tokens would have cost as plain input, minus what they did cost. The input rate (USD per
 * token) is taken from the entry itself, which follows pi's cost tiers; `fallbackInputRate` answers when the
 * entry read no uncached input. Unpriced entries save nothing. Negative when cache writes outweigh the reads.
 */
export function netCacheSavings(u: NormalizedUsage, fallbackInputRate?: number): number {
  if (isUnpriced(u)) return 0;
  const inputRate = u.input > 0 ? u.cost.input / u.input : fallbackInputRate;
  if (inputRate === undefined || !Number.isFinite(inputRate)) return 0;
  return (u.cacheRead + u.cacheWrite) * inputRate - (u.cost.cacheRead + u.cost.cacheWrite);
}

/**
 * Whether an entry was written by the file it sits in. A fork copies its parent's entries with their original,
 * earlier timestamps into a file whose header is stamped at fork time, so a copied entry predates the header.
 * An entry or header with no readable timestamp counts as own.
 */
export function isOwnEntry(entry: AccountingEntry, headerTimestamp: unknown): boolean {
  const header = typeof headerTimestamp === 'string' ? Date.parse(headerTimestamp) : NaN;
  const own = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (Number.isNaN(header) || Number.isNaN(own)) return true;
  return own >= header;
}

/** A conversation's own spend: every counted entry its file wrote, never the entries a fork copied. */
export function sumOwnUsage(entries: Iterable<AccountingEntry>, headerTimestamp: unknown): UsageTotals {
  return sumUsage(entries, (entry) => isOwnEntry(entry, headerTimestamp));
}

/** The conversation's own user prompts on a branch: user messages written by this file. */
export function countOwnUserPrompts(branch: Iterable<AccountingEntry>, headerTimestamp: unknown): number {
  let count = 0;
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message?.role === 'user' && isOwnEntry(entry, headerTimestamp)) count++;
  }
  return count;
}
