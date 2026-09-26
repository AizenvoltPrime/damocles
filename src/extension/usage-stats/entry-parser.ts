import { usageOfEntry, type AccountingEntry, type NormalizedUsage } from '../../shared/usage-accounting';
import { DAMOCLES_AGENT_LAUNCH_ENTRY } from '../pi-session/session-store/constants';

/**
 * Pure line parsers for pi session files and the sub-call ledger. The stats worker imports this module,
 * so it must stay free of `vscode`, pi and host-only modules.
 */

export type EntryKind = 'assistant' | 'tool_result' | 'compaction' | 'branch_summary' | 'subcall' | `usage:${string}`;

export interface UsageLine {
  kind: 'usage';
  id: string;
  timestamp: string;
  tsMs: number;
  entryKind: EntryKind;
  /** Null on compaction and branch summaries, which the indexer attributes to the file's latest model. */
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  usage: NormalizedUsage;
}

export type SessionLine =
  | { kind: 'skip' }
  | { kind: 'error' }
  | { kind: 'header'; id: string; timestamp: string; startedMs: number; cwd: string }
  | { kind: 'title'; name: string }
  | { kind: 'launch'; detail: string }
  | { kind: 'model'; provider: string; model: string }
  | UsageLine;

export type LedgerLine =
  | { kind: 'skip' }
  | { kind: 'error' }
  | (UsageLine & { purpose: string; cwd: string | null; sessionId: string | null });

const SESSION_MARKERS = [
  '"usage":{',
  '"type":"session"',
  '"type":"session_info"',
  '"type":"model_change"',
  `"customType":"${DAMOCLES_AGENT_LAUNCH_ENTRY}"`,
];

const SKIP = { kind: 'skip' } as const;
const ERROR = { kind: 'error' } as const;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseObject(line: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function entryKindOf(entry: Json): EntryKind {
  if (entry['type'] === 'usage') return `usage:${typeof entry['kind'] === 'string' ? entry['kind'] : ''}`;
  if (entry['type'] === 'compaction') return 'compaction';
  if (entry['type'] === 'branch_summary') return 'branch_summary';
  return isRecord(entry['message']) && entry['message']['role'] === 'toolResult' ? 'tool_result' : 'assistant';
}

/** The usage an entry bills, or an error when it bills usage but lacks the id or timestamp that key it. */
function usageLine(entry: Json): UsageLine | typeof SKIP | typeof ERROR {
  const usage = usageOfEntry(entry as AccountingEntry);
  if (!usage) return SKIP;
  const tsMs = timestampMs(entry['timestamp']);
  if (!nonEmptyString(entry['id']) || tsMs === undefined) return ERROR;
  const source = entry['type'] === 'message' && isRecord(entry['message']) ? entry['message'] : entry;
  return {
    kind: 'usage',
    id: entry['id'],
    timestamp: entry['timestamp'] as string,
    tsMs,
    entryKind: entryKindOf(entry),
    provider: nonEmptyString(source['provider']) ? source['provider'] : null,
    model: nonEmptyString(source['model']) ? source['model'] : null,
    stopReason: nonEmptyString(source['stopReason']) ? source['stopReason'] : null,
    usage,
  };
}

/** Parse one pi session file line. Never throws; a line that is not valid JSON is an error. */
export function parseSessionLine(line: string): SessionLine {
  if (!SESSION_MARKERS.some((marker) => line.includes(marker))) return SKIP;
  const entry = parseObject(line);
  if (!entry) return ERROR;
  switch (entry['type']) {
    case 'session': {
      const startedMs = timestampMs(entry['timestamp']);
      if (!nonEmptyString(entry['id']) || startedMs === undefined || !nonEmptyString(entry['cwd'])) return ERROR;
      return { kind: 'header', id: entry['id'], timestamp: entry['timestamp'] as string, startedMs, cwd: entry['cwd'] };
    }
    case 'session_info':
      return typeof entry['name'] === 'string' ? { kind: 'title', name: entry['name'] } : SKIP;
    case 'model_change':
      return nonEmptyString(entry['provider']) && nonEmptyString(entry['modelId'])
        ? { kind: 'model', provider: entry['provider'], model: entry['modelId'] }
        : SKIP;
    case 'custom': {
      if (entry['customType'] !== DAMOCLES_AGENT_LAUNCH_ENTRY || !isRecord(entry['data'])) return SKIP;
      const data = entry['data'];
      const detail = data['kind'] === 'subagent' ? data['agentType'] : data['kind'] === 'team-member' ? data['role'] : undefined;
      return nonEmptyString(detail) ? { kind: 'launch', detail } : SKIP;
    }
    default:
      return usageLine(entry);
  }
}

/** Parse one sub-call ledger line (`subcall-ledger.ts`). Never throws. */
export function parseLedgerLine(line: string): LedgerLine {
  if (!line.includes('"usage":{')) return SKIP;
  const record = parseObject(line);
  if (!record) return ERROR;
  if (record['type'] !== 'subcall') return SKIP;
  const tsMs = timestampMs(record['timestamp']);
  if (
    !nonEmptyString(record['id']) ||
    tsMs === undefined ||
    !nonEmptyString(record['provider']) ||
    !nonEmptyString(record['model']) ||
    !isRecord(record['usage'])
  ) {
    return ERROR;
  }
  const usage = usageOfEntry({ type: 'usage', usage: record['usage'] });
  if (!usage) return ERROR;
  return {
    kind: 'usage',
    id: record['id'],
    timestamp: record['timestamp'] as string,
    tsMs,
    entryKind: 'subcall',
    provider: record['provider'],
    model: record['model'],
    stopReason: nonEmptyString(record['stopReason']) ? record['stopReason'] : null,
    usage,
    purpose: nonEmptyString(record['purpose']) ? record['purpose'] : 'unknown',
    cwd: nonEmptyString(record['cwd']) ? record['cwd'] : null,
    sessionId: nonEmptyString(record['sessionId']) ? record['sessionId'] : null,
  };
}

const DATED_MODEL_SUFFIX = /^(.+)-\d{8}$/;

/**
 * `provider/model`, with a dated id (`claude-haiku-4-5-20251001`) mapped to its base id when only the base
 * is in the registry. The cache warmer records the provider's response model, which carries the date.
 */
export function normalizeModelKey(provider: string, model: string, registryKeys: ReadonlySet<string>): string {
  const key = `${provider}/${model}`;
  if (registryKeys.has(key)) return key;
  const base = DATED_MODEL_SUFFIX.exec(model)?.[1];
  if (base !== undefined && registryKeys.has(`${provider}/${base}`)) return `${provider}/${base}`;
  return key;
}
