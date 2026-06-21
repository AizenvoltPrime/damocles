import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';
import type { StoredSession } from '@shared/types/session';
import { DAMOCLES_USER_RENAMED_ENTRY, DAMOCLES_TAG_ENTRY } from './constants';
import { extractOriginalInputs } from './original-input';
import { stripIdeContext } from './ide-context';

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
  };
}

interface PiMessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
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
 * original typed text when a slash command was expanded, else the stored content with its merged IDE-context
 * prefix stripped (so a plain message sent with a file open isn't mistaken for a synthetic `<…>` prompt and
 * skipped). The live `PiSession._firstUserMessage` captures the same original typed text, so the two agree.
 * Returns '' when none qualifies.
 */
export function extractFirstUserMessage(branch: readonly SessionEntry[]): string {
  const originalInputs = extractOriginalInputs(branch);
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: PiMessageLike }).message;
    if (message?.role !== 'user') continue;
    const text = originalInputs.get(entry.id) ?? stripIdeContext(extractMessageText(message.content));
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

  for (const entry of branch) {
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
  };
}
