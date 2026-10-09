import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ContentInput } from '../session-types';
import { isImageBlock, type ImageBlock, type UserContentBlock } from '../../shared/types/content';
import { withoutTerminalAttachments } from '../terminal-attachment';

/**
 * Generic, plan-mode-agnostic helpers that read pi message/branch content. `piMessageText` is the
 * most-shared helper in `pi-session.ts` — it is exported from here only and imported everywhere, never
 * duplicated. Pure over pi data shapes (no `Deps` interface, no `this`).
 */

/** Join the text blocks of a webview content input (string passes through). */
export function extractText(content: ContentInput): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Convert webview Anthropic-shaped image blocks to pi `ImageContent`. */
export function extractImages(content: ContentInput): ImageContent[] {
  if (typeof content === 'string') return [];
  return content
    .filter((b): b is Extract<UserContentBlock, { type: 'image' }> => b.type === 'image')
    .map((b) => ({ type: 'image', data: b.source.data, mimeType: b.source.media_type }));
}

/** The inverse of `extractImages` over a pi message's content: its image parts with a supported media type and non-empty data. */
export function toImageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part: unknown): unknown => {
      const p = part as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
      return p?.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } } : null;
    })
    .filter(isImageBlock);
}

/** Join the text blocks of a pi message's content (used for the title exchange). */
export function piMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * The user + assistant text of the turn opened by the prompt entry `userEntryId`, walking the active
 * branch forward from that entry: user-role messages (the prompt plus any mid-turn steers and notes)
 * and assistant-role messages (including held-continuation synthesis rounds) are joined separately.
 * Skips custom_message entries (subagent results / plan-mode nudge are display:false custom messages,
 * not user turns). Null when the entry is not on the branch. `files` are the turn's tool-call paths
 * (up to 20), so extraction can tell which repo the turn touched.
 */
export function turnExchangeFrom(
  session: AgentSession,
  userEntryId: string,
  cwd: string,
): { userText: string; assistantText: string; files: string[] } | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  const start = branch.findIndex((e) => e.id === userEntryId);
  if (start === -1) return null;
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const files = new Set<string>();
  for (let i = start; i < branch.length; i++) {
    const entry = branch[i];
    if (!entry || entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role === 'user') {
      const t = withoutTerminalAttachments(piMessageText(message.content));
      if (t) userParts.push(t);
    } else if (message?.role === 'assistant') {
      const t = piMessageText(message.content);
      if (t) assistantParts.push(t);
      collectToolCallPaths(message.content, cwd, files);
    }
  }
  return { userText: userParts.join('\n\n'), assistantText: assistantParts.join('\n\n'), files: [...files] };
}

const MAX_TURN_FILES = 20;

/** Adds the `path`/`file_path` arguments of an assistant message's tool calls, resolved against `cwd`. */
function collectToolCallPaths(content: unknown, cwd: string, into: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (into.size >= MAX_TURN_FILES) return;
    const b = block as { type?: unknown; arguments?: Record<string, unknown> } | null;
    if (b?.type !== 'toolCall' || !b.arguments) continue;
    for (const key of ['path', 'file_path'] as const) {
      const value = b.arguments[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      into.add(path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value));
      if (into.size >= MAX_TURN_FILES) return;
    }
  }
}

/** The first user+assistant exchange (truncated) used as the title-generation input, or null. */
export function firstExchangeForTitle(session: AgentSession): string | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  let userText = '';
  let assistantText = '';
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!userText && message?.role === 'user') userText = withoutTerminalAttachments(piMessageText(message.content));
    else if (!assistantText && message?.role === 'assistant') assistantText = piMessageText(message.content);
    if (userText && assistantText) break;
  }
  if (!userText) return null;
  return `User: ${userText.slice(0, 2000)}\n\nAssistant: ${assistantText.slice(0, 2000)}`;
}
