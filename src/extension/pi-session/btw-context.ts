import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { piMessageText } from './branch-text';

/**
 * The `/btw` side-question context assembly (US-025): the char-capped conversation snapshot and the
 * tool-less aside's system prompt. Pure over the live session's messages — the caller resolves the
 * session and passes it in (the modules never capture `this`).
 */

/** Char budget for the conversation context shared into a `/btw` aside (drops oldest turns when over). */
export const BTW_MAX_CONTEXT_CHARS = 400_000;

export const BTW_SYSTEM_PROMPT = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

/** The current conversation branch as plain User/Assistant text, capped to the btw char budget. */
export function buildBtwContextBlock(session: AgentSession): string {
  const lines: string[] = [];
  for (const raw of session.messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = piMessageText(msg.content).trim();
    if (!text) continue;
    lines.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  let block = lines.join('\n\n');
  while (block.length > BTW_MAX_CONTEXT_CHARS && lines.length > 1) {
    lines.shift();
    block = lines.join('\n\n');
  }
  return block.length > BTW_MAX_CONTEXT_CHARS ? block.slice(block.length - BTW_MAX_CONTEXT_CHARS) : block;
}
