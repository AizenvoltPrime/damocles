import type { InjectionTier } from '@shared/types/context-injection';

export type NoticeKind = 'superseded' | 'edited' | 'forgotten';

/**
 * Structured record on each context-injection custom message. pi persists `details` but never sends
 * it to the model, so it is the only source of which memories are in context (never parse the text).
 */
export interface ContextInjectionDetailsV1 {
  v: 1;
  promptIndex: number;
  /** `hash` is the `memories.content_hash` of the version rendered. */
  memories: Array<{ id: string; hash: string; tier: InjectionTier }>;
  notices: Array<{ id: string; kind: NoticeKind }>;
  profile: boolean;
  /** Change key of the Compass status sent in this message; null when none was sent. */
  compassKey: string | null;
}

export interface LiveMemory {
  hash: string;
  tier: InjectionTier;
  promptIndex: number;
}

/** What the model currently sees, folded from the session projection's injection messages. */
export interface LiveInjections {
  memories: Map<string, LiveMemory>;
  profileInContext: boolean;
  compassKey: string | null;
}

export function emptyLiveInjections(): LiveInjections {
  return { memories: new Map(), profileInContext: false, compassKey: null };
}

const NOTICE_KINDS: ReadonlySet<string> = new Set<NoticeKind>(['superseded', 'edited', 'forgotten']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMemoryItem(v: unknown): v is ContextInjectionDetailsV1['memories'][number] {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['hash'] === 'string' &&
    (v['tier'] === 'full' || v['tier'] === 'compact')
  );
}

function isNoticeItem(v: unknown): v is ContextInjectionDetailsV1['notices'][number] {
  return isRecord(v) && typeof v['id'] === 'string' && typeof v['kind'] === 'string' && NOTICE_KINDS.has(v['kind']);
}

export function isContextInjectionDetails(v: unknown): v is ContextInjectionDetailsV1 {
  return (
    isRecord(v) &&
    v['v'] === 1 &&
    typeof v['promptIndex'] === 'number' &&
    Number.isFinite(v['promptIndex']) &&
    Array.isArray(v['memories']) &&
    v['memories'].every(isMemoryItem) &&
    Array.isArray(v['notices']) &&
    v['notices'].every(isNoticeItem) &&
    typeof v['profile'] === 'boolean' &&
    (v['compassKey'] === null || typeof v['compassKey'] === 'string')
  );
}
