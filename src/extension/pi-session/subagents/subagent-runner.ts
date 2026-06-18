/**
 * subagent-runner.ts — Core execution: subscribe, prompt, collect, enforce the turn limit.
 *
 * Adapted from @tintinweb/pi-subagents `agent-runner.ts` (MIT, © 2026 tintinweb; see
 * THIRD-PARTY-NOTICES.md). The heavy session-construction logic (resource loader, extension filtering,
 * model resolution) moved out: the caller supplies a `createSession` thunk that builds the nested
 * session via `PiRuntime.createSubagentSession`. Worktree isolation and `inherit_context` are dropped.
 * What remains is upstream's lifecycle: abort forwarding, graceful turn-limit enforcement, usage
 * accumulation, response-text collection, and the conversation formatter.
 */

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** Info about a tool event in the subagent (drives the parent card's tool-use count). */
export interface ToolActivity {
  type: 'start' | 'end';
  toolName: string;
}

export interface RunSubagentOptions {
  /** Build the nested session (model/tools/prompt/factory already resolved by the caller). */
  createSession: () => Promise<AgentSession>;
  prompt: string;
  /** Soft turn limit; undefined or 0 = unlimited. */
  maxTurns?: number;
  /** Additional turns allowed after the soft-limit steer before a hard abort. */
  graceTurns?: number;
  signal?: AbortSignal;
  onSessionCreated?: (session: AgentSession) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
}

const DEFAULT_GRACE_TURNS = 5;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Extract text from a message content block array. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c as { type?: string }).type === 'text')
    .map((c) => (c as { text?: string }).text ?? '')
    .join('\n');
}

/** Subscribe and collect the last assistant message text streamed during the run. */
function collectResponseText(session: AgentSession): { getText: () => string; unsubscribe: () => void } {
  let text = '';
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_start') text = '';
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'assistant') continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return '';
}

/** Wire an AbortSignal to abort a session. Returns a cleanup function. */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  // The signal can already be aborted by the time this runs — the session is built behind an
  // `await createSession()`, so an abort fired during construction passes before the listener exists.
  // An already-aborted signal never re-fires 'abort', so check up-front or the cancel is silently lost.
  if (signal.aborted) {
    void session.abort();
    return () => {};
  }
  const onAbort = () => void session.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Run a subagent session to completion. */
export async function runSubagent(options: RunSubagentOptions): Promise<RunResult> {
  const session = await options.createSession();
  options.onSessionCreated?.(session);

  const maxTurns = normalizeMaxTurns(options.maxTurns);
  const graceTurns = Math.max(1, options.graceTurns ?? DEFAULT_GRACE_TURNS);
  let turnCount = 0;
  let softLimitReached = false;
  let aborted = false;

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'turn_end') {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          void session.steer('You have reached your turn limit. Wrap up immediately — provide your final answer now.').catch(() => {});
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          void session.abort();
        }
      }
    }
    if (event.type === 'tool_execution_start') options.onToolActivity?.({ type: 'start', toolName: event.toolName });
    if (event.type === 'tool_execution_end') options.onToolActivity?.({ type: 'end', toolName: event.toolName });
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const usage = (event.message as { usage?: { input?: number; output?: number; cacheWrite?: number } }).usage;
      if (usage) {
        options.onAssistantUsage?.({ input: usage.input ?? 0, output: usage.output ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
      }
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  try {
    await session.prompt(options.prompt);
  } finally {
    unsub();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  // A hard abort after the grace window sets both flags; report only `aborted` so the pair can't
  // contradict (the soft-limit steer is subsumed by the abort).
  return { responseText, session, aborted, steered: softLimitReached && !aborted };
}

/** Send a steering message to a running subagent. */
export async function steerSubagent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

/** Format the subagent's conversation messages as readable text (for GetSubagentResult verbose mode). */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];
  for (const raw of session.messages) {
    const msg = raw as { role?: string; content?: unknown; toolName?: string };
    if (msg.role === 'user') {
      const text = extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      const blocks = Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string; name?: string; toolName?: string }>)
        : [];
      for (const c of blocks) {
        if (c.type === 'text' && c.text) textParts.push(c.text);
        else if (c.type === 'toolCall') toolCalls.push(`  Tool: ${c.name ?? c.toolName ?? 'unknown'}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join('\n')}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join('\n')}`);
    } else if (msg.role === 'toolResult') {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
      parts.push(`[Tool Result (${msg.toolName ?? 'tool'})]: ${truncated}`);
    }
  }
  return parts.join('\n\n');
}
