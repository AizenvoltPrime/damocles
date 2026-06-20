/**
 * output-file.ts — Streaming JSONL output file for subagent transcripts (+ history rehydrate reader).
 *
 * Adapted from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Transcripts are repointed from `/tmp` to the Damocles-owned tree:
 *   ~/.damocles/pi/subagents/<encoded-cwd>/<sessionId>/tasks/<agentId>.jsonl
 *
 * Each transcript is self-describing: its initial entry records the spawning `Agent` tool-call id
 * (`parentToolUseId` — the webview's subagent-card key), the agent type, and the resolved model, so a
 * resumed session can rehydrate the subagent card without any correlation entry in the parent pi
 * session file (which is owned by pi and must not be second-written — see CLAUDE.md).
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { HistoryAgentMessage } from '../../../shared/types/content';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { piMessagesToHistoryAgentMessages } from './message-mapper';

/** Root for subagent transcripts, isolated under the Damocles home dir. */
const SUBAGENTS_ROOT = join(DAMOCLES_HOME_DIR, 'pi', 'subagents');

/** Metadata that makes a transcript self-correlating to its parent `Agent` tool card on resume. */
export interface TranscriptMeta {
  /** The spawning `Agent` tool-call id — the webview subagent-card key. */
  parentToolUseId: string;
  /** The agent type name (e.g. "Explore"). */
  agentType: string;
  /** The resolved model label, when known. */
  model?: string;
  /** Absolute path to the agent's markdown template file, when it ran from one. */
  templatePath?: string;
}

/** Rehydrated transcript for one subagent, keyed for restore by `parentToolUseId`. */
export interface SubagentTranscript {
  agentId: string;
  parentToolUseId: string;
  agentType?: string;
  model?: string;
  templatePath?: string;
  messages: HistoryAgentMessage[];
  startTimestamp?: number;
  endTimestamp?: number;
  totalToolUseCount: number;
  /** Manager terminal status (`completed`/`steered`/`aborted`/`stopped`/`error`), persisted at completion. */
  status?: string;
  /** Final result text (raw result + status note) — the authoritative card content on resume. */
  finalResult?: string;
}

/**
 * Encode a cwd path as a filesystem-safe directory name. Matches the session-dir style:
 *   - POSIX:   "/home/user/project"   → "home-user-project"
 *   - Windows: "C:\Users\foo\project" → "Users-foo-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/^[A-Za-z]:[/\\]/, '') // strip Windows drive prefix ("C:\")
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '');
}

/** The directory holding all of a session's subagent transcripts. */
export function transcriptTasksDir(cwd: string, sessionId: string): string {
  return join(SUBAGENTS_ROOT, encodeCwd(cwd), sessionId || 'no-session', 'tasks');
}

/** The on-disk transcript path for one subagent (no directory creation — for reads / "open log"). */
export function subagentTranscriptPath(cwd: string, sessionId: string, agentId: string): string {
  return join(transcriptTasksDir(cwd, sessionId), `${agentId}.jsonl`);
}

/** Create the transcript file path, ensuring the directory exists. */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const dir = transcriptTasksDir(cwd, sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.jsonl`);
}

/**
 * Write the initial user prompt entry, stamped with the metadata needed to rehydrate the card.
 * Returns false if the header could not be written — the caller must then skip streaming, since the
 * `parentToolUseId`/`agentId` correlation lives ONLY in this header and `parseTranscript` discards a
 * file that lacks it (a header-less file of streamed turns is unrecoverable, not partially recovered).
 */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string, meta: TranscriptMeta): boolean {
  const entry = {
    isSidechain: true,
    agentId,
    parentToolUseId: meta.parentToolUseId,
    agentType: meta.agentType,
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.templatePath ? { templatePath: meta.templatePath } : {}),
    type: 'user',
    message: { role: 'user', content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  try {
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Append the terminal-status entry, so a resumed card rehydrates the real outcome instead of inferring
 * it from the parent `Agent` tool result (which for a background spawn is only `{status:async_launched}`).
 * `status` is the manager's terminal status; `resultText` is the final result + status note the parent saw.
 */
export function writeFinalEntry(path: string, agentId: string, status: string, resultText: string): void {
  const entry = { isSidechain: true, agentId, type: 'status', status, result: resultText, timestamp: new Date().toISOString() };
  try {
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* best-effort — the message stream is already persisted */
  }
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(session: AgentSession, path: string, agentId: string, cwd: string): () => void {
  // The prompt (the first user message) is already persisted by writeInitialEntry; everything after it
  // is streamed here. Resolve that boundary by role on the first flush rather than assuming the prompt
  // is at index 0 — a prepended system/setup message would otherwise duplicate the prompt or drop a turn.
  let writtenCount = -1;

  const flush = (): void => {
    const messages = session.messages;
    if (writtenCount < 0) {
      const promptIdx = messages.findIndex((m) => (m as { role?: string } | undefined)?.role === 'user');
      if (promptIdx < 0) return; // prompt not in the message list yet — nothing to stream
      writtenCount = promptIdx + 1;
    }
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount] as { role?: string } | undefined;
      writtenCount++;
      if (!msg) continue;
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'toolResult',
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
      } catch {
        /* ignore write errors */
      }
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'turn_end') flush();
  });

  return () => {
    flush();
    unsubscribe();
  };
}

interface TranscriptEntry {
  agentId?: string;
  parentToolUseId?: string;
  agentType?: string;
  model?: string;
  templatePath?: string;
  message?: unknown;
  timestamp?: string;
  type?: string;
  status?: string;
  result?: string;
}

function countToolUses(messages: readonly HistoryAgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_use') count++;
    }
  }
  return count;
}

/** Parse a single transcript file into a rehydratable record. Returns null when it can't be correlated. */
export function parseTranscript(content: string): SubagentTranscript | null {
  const piMessages: unknown[] = [];
  let agentId: string | undefined;
  let parentToolUseId: string | undefined;
  let agentType: string | undefined;
  let model: string | undefined;
  let templatePath: string | undefined;
  let startTimestamp: number | undefined;
  let endTimestamp: number | undefined;
  let status: string | undefined;
  let finalResult: string | undefined;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.agentId && !agentId) agentId = entry.agentId;
    if (entry.parentToolUseId && !parentToolUseId) parentToolUseId = entry.parentToolUseId;
    if (entry.agentType && !agentType) agentType = entry.agentType;
    if (entry.model && !model) model = entry.model;
    if (entry.templatePath && !templatePath) templatePath = entry.templatePath;
    if (entry.timestamp) {
      const ts = Date.parse(entry.timestamp);
      if (Number.isFinite(ts)) {
        if (startTimestamp === undefined || ts < startTimestamp) startTimestamp = ts;
        if (endTimestamp === undefined || ts > endTimestamp) endTimestamp = ts;
      }
    }
    // The terminal-status entry (latest wins) — never a conversation message, so it isn't replayed.
    if (entry.type === 'status') {
      if (entry.status) status = entry.status;
      if (typeof entry.result === 'string') finalResult = entry.result;
      continue;
    }
    if (entry.message !== undefined && entry.message !== null) piMessages.push(entry.message);
  }

  if (!parentToolUseId || !agentId) return null;

  const messages = piMessagesToHistoryAgentMessages(piMessages);
  return {
    agentId,
    parentToolUseId,
    ...(agentType ? { agentType } : {}),
    ...(model ? { model } : {}),
    ...(templatePath ? { templatePath } : {}),
    messages,
    ...(startTimestamp !== undefined ? { startTimestamp } : {}),
    ...(endTimestamp !== undefined ? { endTimestamp } : {}),
    totalToolUseCount: countToolUses(messages),
    ...(status ? { status } : {}),
    ...(finalResult !== undefined ? { finalResult } : {}),
  };
}

/**
 * Read all subagent transcripts for a resumed session, keyed by `parentToolUseId` (the `Agent`
 * tool-call id) so the history loader can attach each to its parent card. Best-effort: a missing
 * directory or unreadable file yields an empty/partial map rather than failing the session load.
 */
export async function readSubagentTranscripts(cwd: string, sessionId: string): Promise<Map<string, SubagentTranscript>> {
  const dir = transcriptTasksDir(cwd, sessionId);
  const out = new Map<string, SubagentTranscript>();

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return out; // no transcripts for this session
  }

  await Promise.all(
    files
      .filter((f) => f.endsWith('.jsonl'))
      .map(async (file) => {
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          const transcript = parseTranscript(content);
          if (transcript) out.set(transcript.parentToolUseId, transcript);
        } catch {
          /* skip unreadable transcript */
        }
      }),
  );

  return out;
}
