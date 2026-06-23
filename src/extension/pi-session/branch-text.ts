import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ContentInput } from '../session-types';
import type { UserContentBlock } from '../../shared/types/content';

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

/** Join the text blocks of a pi message's content (used for the title exchange). */
export function piMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/** The last user-role message entry on the active branch — its id plus stored text. */
export function lastUserEntry(session: AgentSession): { id: string; text: string } | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === 'message' && (entry as { message?: { role?: string } }).message?.role === 'user') {
      return { id: entry.id, text: piMessageText((entry as { message?: { content?: unknown } }).message?.content) };
    }
  }
  return null;
}

/**
 * The user + assistant text this turn committed AFTER `priorUserEntryId`. Walks the active branch
 * forward from the entry following the prior boundary, joining user-role messages (the prompt plus
 * any mid-turn steers) and assistant-role messages (including held-continuation synthesis rounds)
 * separately. Skips custom_message entries (subagent results / plan-mode nudge are display:false
 * custom messages, not user turns). Returns null when no NEW user message was committed (the index
 * never advances past priorUserEntryId — e.g. a pi extension command that ran no agent turn).
 */
export function turnExchangeAfter(
  session: AgentSession,
  priorUserEntryId: string | null,
): { userText: string; assistantText: string } | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  let start = 0;
  if (priorUserEntryId !== null) {
    const idx = branch.findIndex((e) => e.id === priorUserEntryId);
    if (idx !== -1) start = idx + 1;
  }
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  let sawUser = false;
  for (let i = start; i < branch.length; i++) {
    const entry = branch[i];
    if (!entry || entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role === 'user') {
      sawUser = true;
      const t = piMessageText(message.content);
      if (t) userParts.push(t);
    } else if (message?.role === 'assistant') {
      const t = piMessageText(message.content);
      if (t) assistantParts.push(t);
    }
  }
  if (!sawUser) return null;
  return { userText: userParts.join('\n\n'), assistantText: assistantParts.join('\n\n') };
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
    if (!userText && message?.role === 'user') userText = piMessageText(message.content);
    else if (!assistantText && message?.role === 'assistant') assistantText = piMessageText(message.content);
    if (userText && assistantText) break;
  }
  if (!userText) return null;
  return `User: ${userText.slice(0, 2000)}\n\nAssistant: ${assistantText.slice(0, 2000)}`;
}
