import type { SessionEntry, SessionHeader, SessionManager } from '@earendil-works/pi-coding-agent';
import type { StoredSession } from '@shared/types/session';
import { DAMOCLES_USER_RENAMED_ENTRY, DAMOCLES_TAG_ENTRY } from './constants';
import { extractOriginalInputs } from './original-input';
import { storedTypedText } from './prompt-context';
import { extractTerminalAttachmentCounts } from './terminal-attachments';

/** Fields computed from a single opened pi session, including the in-tree rename marker and tag. */
export interface PiSessionFields {
  id: string;
  name: string | undefined;
  firstMessage: string;
  messageCount: number;
  created: number;
  modified: number;
  userRenamed: boolean;
  tag: string | undefined;
  model: StoredSession['model'];
}

/** Marker-aware mapping: a user-renamed session's name becomes `customTitle`, else `aiTitle`. */
export function mapPiFieldsToStored(f: PiSessionFields): StoredSession {
  return {
    id: f.id,
    timestamp: f.modified,
    createdAt: f.created,
    preview: f.firstMessage,
    messageCount: f.messageCount,
    ...(f.name ? (f.userRenamed ? { customTitle: f.name } : { aiTitle: f.name }) : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(f.model ? { model: f.model } : {}),
  };
}

interface PiMessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  provider?: unknown;
  model?: unknown;
}

/** Join text blocks of a pi message into a single string (matches pi's `extractTextContent`). */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * The first user message of a branch that isn't a synthetic `<…>`-prefixed prompt (memory injection,
 * plan acknowledgement, etc.) — the same value `computePiSessionFields` records as `StoredSession.preview`.
 * The deterministic plan-file slug derives from this, so a path computed from a live `PiSession` matches
 * the path resolved from on-disk metadata. Resolution per entry: the `damocles-original-input` sidecar's
 * original typed text when a slash command was expanded, else the stored content with its terminal attachment and
 * IDE-context prefix stripped (so a plain message sent with a file open isn't mistaken for a synthetic `<…>` prompt and
 * skipped). The live `PiSession._firstUserMessage` captures the same original typed text, so the two agree.
 * Returns '' when none qualifies.
 */
export function extractFirstUserMessage(branch: readonly SessionEntry[]): string {
  const originalInputs = extractOriginalInputs(branch);
  const attachmentCounts = extractTerminalAttachmentCounts(branch);
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: PiMessageLike }).message;
    if (message?.role !== 'user') continue;
    const text = originalInputs.get(entry.id) ?? storedTypedText(extractMessageText(message.content), attachmentCounts.get(entry.id) ?? 0);
    if (text && !text.trimStart().startsWith('<')) return text;
  }
  return '';
}

/**
 * Compute the `StoredSession` fields for one pi session from the entries of its ACTIVE branch
 * (root→leaf — the caller must pass `getBranch(getLeafId())`, NOT `getEntries()`, so abandoned
 * rewind/fork branches don't inflate the counts). `messageCount` counts only user/assistant turns
 * (tool-result messages are excluded), and `firstMessage` skips synthetic `<…>`-prefixed prompts —
 * so the picker matches what actually renders. Also detects the rename/tag markers.
 */
export function computePiSessionFields(
  header: SessionHeader,
  branch: readonly SessionEntry[],
  name: string | undefined,
  mtimeMs: number,
): PiSessionFields {
  let messageCount = 0;
  let lastActivity: number | undefined;
  let userRenamed = false;
  let tag: string | undefined;
  // pi resumes on the branch's latest model change or assistant reply (`getSessionContextSettings`).
  let model: StoredSession['model'];

  for (const entry of branch) {
    if (entry.type === 'model_change') {
      // A session file is untrusted input, so a malformed entry never puts a non-string into a listed row.
      if (typeof entry.provider === 'string' && typeof entry.modelId === 'string') model = { provider: entry.provider, id: entry.modelId };
      continue;
    }
    if (entry.type === 'custom' && entry.customType === DAMOCLES_USER_RENAMED_ENTRY) {
      userRenamed = true;
      continue;
    }
    if (entry.type === 'custom' && entry.customType === DAMOCLES_TAG_ENTRY) {
      // Latest tag entry wins; a null/empty tag clears it.
      const value = (entry.data as { tag?: unknown } | undefined)?.tag;
      tag = typeof value === 'string' && value.length > 0 ? value : undefined;
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: PiMessageLike }).message;
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'assistant' && typeof message?.provider === 'string' && typeof message.model === 'string') {
      model = { provider: message.provider, id: message.model };
    }
    messageCount++;
    const activity = typeof message?.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
    if (!Number.isNaN(activity)) lastActivity = Math.max(lastActivity ?? 0, activity);
  }

  const firstMessage = extractFirstUserMessage(branch);

  const headerTime = Date.parse(header.timestamp);
  const created = Number.isNaN(headerTime) ? mtimeMs : headerTime;
  const modified = lastActivity && lastActivity > 0 ? lastActivity : created;

  return {
    id: header.id,
    name: name?.trim() || undefined,
    firstMessage: firstMessage || '(no messages)',
    messageCount,
    created,
    modified,
    userRenamed,
    tag,
    model,
  };
}

/** The up-arrow prompt history holds at most this many prompts across every session. */
export const PI_PROMPT_HISTORY_CAP = 500;

/**
 * The user prompts of an ACTIVE branch, newest first, each kept once and at most `PI_PROMPT_HISTORY_CAP`.
 * Dropping an older in-session duplicate and the tail past the cap cannot change the merged history,
 * which walks newest first, skips anything already seen and stops at the cap.
 */
export function newestUniquePrompts(branch: readonly SessionEntry[]): string[] {
  // A user message whose typed slash command was expanded is recorded here as what the user typed
  // (`/example what is the day`), not the stored expansion (`Hello day is Tuesday`).
  const originalInputs = extractOriginalInputs(branch);
  const attachmentCounts = extractTerminalAttachmentCounts(branch);
  const prompts: string[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: PiMessageLike }).message;
    if (message?.role !== 'user') continue;
    const text = (originalInputs.get(entry.id) ?? storedTypedText(extractMessageText(message.content), attachmentCounts.get(entry.id) ?? 0)).trim();
    if (text && !text.startsWith('<')) prompts.push(text);
  }
  const seen = new Set<string>();
  const newest: string[] = [];
  for (let i = prompts.length - 1; i >= 0 && newest.length < PI_PROMPT_HISTORY_CAP; i--) {
    const p = prompts[i]!;
    if (seen.has(p)) continue;
    seen.add(p);
    newest.push(p);
  }
  return newest;
}

/** Persisted by `session-meta-cache.ts`: a change to what fills it must bump `SESSION_META_SCHEMA`. */
export interface SessionFileMeta {
  /** `null` when the file has no session header. */
  stored: StoredSession | null;
  prompts: string[];
}

type SessionManagerView = Pick<SessionManager, 'getHeader' | 'getEntries' | 'getBranch' | 'getSessionName'>;

/**
 * A session's list metadata and prompts, as `SessionManager.open` of its file yields them. The branch
 * ends at the last entry, which is where `open` puts the leaf; a live manager may have moved its leaf
 * (a rewind before the next append) without writing, and the file does not show that yet.
 */
export function sessionFileMeta(sm: SessionManagerView, mtimeMs: number): SessionFileMeta {
  const header = sm.getHeader();
  if (!header) return { stored: null, prompts: [] };
  const entries = sm.getEntries();
  const lastId = entries[entries.length - 1]?.id;
  const branch = lastId === undefined ? [] : sm.getBranch(lastId);
  const fields = computePiSessionFields(header, branch, sm.getSessionName(), mtimeMs);
  return { stored: mapPiFieldsToStored(fields), prompts: newestUniquePrompts(branch) };
}
