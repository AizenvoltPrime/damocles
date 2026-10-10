import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { HistoryToolCall } from '@shared/types/content';

// Hermetic fixtures for driving loadPiSessionHistory without the real pi runtime. Agent files are real
// JSONL under a temp session dir, parsed by pi's own `parseSessionEntries`.
const hoisted = vi.hoisted(() => ({ branch: [] as unknown[], sessionDir: '/fake/dir', entries: null as unknown[] | null, headerTimestamp: undefined as string | undefined }));
vi.mock('../../pi-loader', async () => {
  const real = await import('@earendil-works/pi-coding-agent');
  return {
    initPiLoader: vi.fn(async () => ({
      SessionManager: {
        open: () => ({
          getLeafId: () => 'leaf',
          getBranch: () => hoisted.branch,
          getEntries: () => hoisted.entries ?? hoisted.branch,
          getHeader: () => (hoisted.headerTimestamp ? { timestamp: hoisted.headerTimestamp } : null),
        }),
      },
      parseSessionEntries: real.parseSessionEntries,
    })),
    loadPiAi: vi.fn(async () => import('@earendil-works/pi-ai')),
  };
});
vi.mock('../reading', () => ({ resolvePiSessionFile: vi.fn(async () => '/fake/session.jsonl') }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: vi.fn(() => hoisted.sessionDir) }));
vi.mock('../../checkpoints', () => ({ getCheckpointEntries: vi.fn(() => []) }));
vi.mock('../../../logger', () => ({ log: vi.fn() }));
vi.mock('../../agent-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-records')>();
  return { ...actual, readAgentFile: vi.fn(actual.readAgentFile) };
});

import { reconstructMessages, loadPiSessionHistory } from '../history-loader';
import { resolvePiSessionFile } from '../reading';
import { getCheckpointEntries } from '../../checkpoints';
import { getCheckpointEntries as realGetCheckpointEntries } from '../../checkpoints/checkpoint-entry';
import { readAgentFile } from '../../agent-records';
import { storedTypedText } from '../prompt-context';
import { platform } from '../../../platform-host';
import elBundle from '../../../../../l10n/bundle.l10n.el.json';
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_SEGMENT_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
  DAMOCLES_STEER_ENTRY,
  DAMOCLES_TURN_STOPPED_ENTRY,
} from '../constants';
import { FORK_AT_SECOND_PROMPT, FORK_PROMPT_COUNT, STORED_CONVERSATION, STORED_PROMPT_COUNT, withPrompt } from './prompt-index-fixtures';

function userMsg(id: string, text: string): SessionEntry {
  return { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}
function assistantMsg(id: string, text: string): SessionEntry {
  return { id, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}
/** A pi 0.86 mid-conversation system message: an ordinary `message` entry carrying `role: "system"`. */
function systemMsg(id: string, sections: Record<string, string | null>): SessionEntry {
  return {
    id,
    type: 'message',
    message: { role: 'system', content: '', sections, timestamp: 1_750_000_000_000 },
  } as unknown as SessionEntry;
}
function originalInput(userEntryId: string, original: string): SessionEntry {
  return { id: `c-${userEntryId}`, type: 'custom', customType: DAMOCLES_ORIGINAL_INPUT_ENTRY, data: { userEntryId, original } } as unknown as SessionEntry;
}
function steerEntry(
  agentId: string,
  message: string,
  opts: { agentType?: string; description?: string; data?: unknown } = {},
): SessionEntry {
  const data =
    'data' in opts
      ? opts.data
      : {
          agentId,
          message,
          ...(opts.agentType ? { agentType: opts.agentType } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        };
  return { id: `s-${agentId}`, type: 'custom', customType: DAMOCLES_STEER_ENTRY, data } as unknown as SessionEntry;
}
function compactionEntry(id: string, summary: string): SessionEntry {
  return {
    id,
    type: 'compaction',
    summary,
    tokensBefore: 1234,
    timestamp: '2026-06-20T20:22:57.439Z',
  } as unknown as SessionEntry;
}

describe('storedTypedText', () => {
  it('strips a merged opened-file wrapper, keeping the real message (pi merges adjacent text blocks)', () => {
    const stored =
      '<ide_opened_file>The user opened the file c:\\x.jsonl in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it';
    expect(storedTypedText(stored, 0)).toBe('what day is it');
  });

  it('strips a multi-line selection wrapper, keeping the real message', () => {
    const stored =
      '<ide_selection>The user selected the lines 1 to 5 from x.ts:\nconst a = 1;\n\nThis may or may not be related to the current task.</ide_selection>\nfix this';
    expect(storedTypedText(stored, 0)).toBe('fix this');
  });

  it('reduces a standalone wrapper block (image-message case) to empty', () => {
    const block = '<ide_opened_file>The user opened the file c:\\x.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>';
    expect(storedTypedText(block, 0)).toBe('');
  });

  it('leaves a normal message untouched', () => {
    expect(storedTypedText('just a normal message', 0)).toBe('just a normal message');
  });

  it('only strips a leading wrapper — a closing tag a user typed mid-message survives', () => {
    const text = 'please keep this </ide_opened_file> literal mid-text';
    expect(storedTypedText(text, 0)).toBe(text);
  });
});

describe('reconstructMessages — compaction', () => {
  it('replaces pre-compaction messages with a summary marker and keeps post-compaction messages', () => {
    const branch = [
      userMsg('u1', 'old question'),
      assistantMsg('a1', 'old answer'),
      compactionEntry('c1', 'the summary'),
      userMsg('u2', 'what did I ask so far'),
      assistantMsg('a2', 'you asked about old things'),
    ];
    const { messages } = reconstructMessages(branch);

    expect(messages.map((m) => m.kind)).toEqual(['compaction', 'user', 'assistant']);
    const marker = messages[0] as { kind: 'compaction'; summary: string; preTokens: number; timestamp: number; entryId: string };
    expect(marker.summary).toBe('the summary');
    expect(marker.preTokens).toBe(1234);
    expect(marker.timestamp).toBe(Date.parse('2026-06-20T20:22:57.439Z'));
    // The marker carries the compaction entry id — the tree node rewind-to-before-compaction branches at.
    expect(marker.entryId).toBe('c1');
    expect((messages[1] as { content: string }).content).toBe('what did I ask so far');
  });

  it('a session compacted more than once shows only the latest summary, as the live view does', () => {
    const branch = [
      userMsg('u1', 'first question'),
      compactionEntry('c1', 'first summary'),
      userMsg('u2', 'second question'),
      compactionEntry('c2', 'second summary'),
      userMsg('u3', 'third question'),
    ];
    const { messages } = reconstructMessages(branch);

    expect(messages.map((m) => m.kind)).toEqual(['compaction', 'user']);
    expect(messages[0]).toMatchObject({ summary: 'second summary', entryId: 'c2' });
  });

  it('a session with no compaction is unaffected', () => {
    const branch = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    const { messages } = reconstructMessages(branch);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
  });
});

describe('reconstructMessages — reply effort', () => {
  const replyAt = (id: string, provider: string, model: string, thinkingLevel?: string): SessionEntry =>
    ({ id, type: 'message', message: { role: 'assistant', provider, model, ...(thinkingLevel ? { thinkingLevel } : {}), content: [{ type: 'text', text: id }] } }) as unknown as SessionEntry;
  const reasons = (provider: string, modelId: string): boolean | undefined =>
    provider === 'anthropic' ? modelId !== 'claude-haiku-4-5' : undefined;
  const efforts = (branch: SessionEntry[]) =>
    reconstructMessages(branch, reasons).messages.filter((m) => m.kind === 'assistant').map((m) => ('effort' in m ? m.effort : undefined));

  it("publishes each reply's recorded level when the registry says its model reasons", () => {
    expect(efforts([userMsg('u1', 'q'), replyAt('a1', 'anthropic', 'claude-opus-5', 'high'), replyAt('a2', 'anthropic', 'claude-opus-5', 'max')])).toEqual(['high', 'max']);
  });

  it('publishes nothing for a model that does not reason, one missing from the registry, or a reply recorded before pi kept the level', () => {
    expect(efforts([
      replyAt('a1', 'anthropic', 'claude-haiku-4-5', 'off'),
      replyAt('a2', 'custom', 'local-model', 'high'),
      replyAt('a3', 'anthropic', 'claude-opus-5'),
    ])).toEqual([undefined, undefined, undefined]);
  });

  it('publishes nothing without a registry lookup', () => {
    const { messages } = reconstructMessages([replyAt('a1', 'anthropic', 'claude-opus-5', 'high')]);
    expect(messages[0]).not.toHaveProperty('effort');
  });
});

describe('reconstructMessages — original slash-command input', () => {
  it('shows the original typed command instead of pi\'s expanded body', () => {
    const branch = [
      userMsg('u1', 'Hello day is Tuesday'), // pi's expansion of /example
      assistantMsg('a1', 'Tuesday it is.'),
      originalInput('u1', '/example what is the day'),
    ];
    const { messages } = reconstructMessages(branch);
    expect((messages[0] as { content: string }).content).toBe('/example what is the day');
  });

  it('leaves a normal user message (no sidecar) untouched', () => {
    const branch = [userMsg('u1', 'just a normal message'), assistantMsg('a1', 'ok')];
    const { messages } = reconstructMessages(branch);
    expect((messages[0] as { content: string }).content).toBe('just a normal message');
  });

  it('substitutes the text but keeps image blocks of an expanded message', () => {
    const branch = [
      {
        id: 'u1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'Hello day is Tuesday' }] },
      } as unknown as SessionEntry,
      assistantMsg('a1', 'ok'),
      originalInput('u1', '/example what is the day'),
    ];
    const { messages } = reconstructMessages(branch);
    const user = messages[0] as { content: string; contentBlocks?: { type: string; text?: string }[] };
    expect(user.content).toBe('/example what is the day');
    expect(user.contentBlocks?.some((b) => b.type === 'image')).toBe(true);
    expect(user.contentBlocks?.find((b) => b.type === 'text')?.text).toBe('/example what is the day');
  });
});

describe('reconstructMessages — steer chip (Slice 3)', () => {
  it('maps a damocles-steer custom entry to a steer ReplayMessage in position with all fields', () => {
    const branch = [
      userMsg('u1', 'go build it'),
      steerEntry('agent-7', 'focus on the parser', { agentType: 'coder', description: 'Build parser' }),
      assistantMsg('a1', 'done'),
    ];
    const { messages } = reconstructMessages(branch);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'steer', 'assistant']);
    const steer = messages[1] as { kind: 'steer'; agentId: string; agentType?: string; description?: string; message: string };
    expect(steer!.agentId).toBe('agent-7');
    expect(steer!.agentType).toBe('coder');
    expect(steer!.description).toBe('Build parser');
    expect(steer!.message).toBe('focus on the parser');
  });

  it('skips a malformed steer payload (missing message / empty agentId)', () => {
    const missingMessage = reconstructMessages([userMsg('u1', 'hi'), steerEntry('agent-7', '', { data: { agentId: 'agent-7' } })]);
    expect(missingMessage.messages.map((m) => m.kind)).toEqual(['user']);

    const emptyAgentId = reconstructMessages([userMsg('u1', 'hi'), steerEntry('', 'msg', { data: { agentId: '', message: 'msg' } })]);
    expect(emptyAgentId.messages.map((m) => m.kind)).toEqual(['user']);
  });
});

describe('reconstructMessages — failed model calls', () => {
  const failed = (id: string, errorMessage: string): SessionEntry =>
    ({ id, type: 'message', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage } }) as unknown as SessionEntry;
  /** pi's `_omitRecoveryAttempt` (agent-session.js:836): a null-replacement edit taking a retried or overflow-recovered call out of model context. */
  const omitted = (targetId: string): SessionEntry =>
    ({ id: `edit-${targetId}`, type: 'context_edit', targetId, replacement: null }) as unknown as SessionEntry;
  const errors = (branch: SessionEntry[]) =>
    reconstructMessages(branch).messages.filter((m) => m.kind === 'error').map((m) => (m as { content: string }).content);

  it('shows a call pi re-ran as nothing and the answer that replaced it, as the live view does', () => {
    const branch = [userMsg('u1', 'hi'), failed('a1', '529 overloaded'), omitted('a1'), assistantMsg('a2', 'the answer')];
    expect(errors(branch)).toEqual([]);
    expect(reconstructMessages(branch).messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
  });

  it('shows only the final failure of a call whose retries ran out', () => {
    const branch = [
      userMsg('u1', 'hi'),
      failed('a1', '529 (1)'), omitted('a1'),
      failed('a2', '529 (2)'), omitted('a2'),
      failed('a3', '529 (3)'), omitted('a3'),
      failed('a4', '529 (4)'),
    ];
    expect(errors(branch)).toEqual(['529 (4)']);
  });

  it('shows a failure that pi did not re-run', () => {
    expect(errors([userMsg('u1', 'hi'), failed('a1', '400 invalid request')])).toEqual(['400 invalid request']);
  });

  // The live adapter names an error stop pi recorded without a message `Unknown error` (pi-stream-adapter.ts holdFailure).
  it('shows the card of a failure pi recorded with no message, as the live view does', () => {
    const silent = { id: 'a1', type: 'message', message: { role: 'assistant', content: [], stopReason: 'error' } } as unknown as SessionEntry;
    expect(errors([userMsg('u1', 'hi'), silent])).toEqual(['Unknown error']);
  });

  /** A call that streamed before it failed: pi keeps the partial content on the error stop (agent-loop.js:286-319). */
  const failedWith = (id: string, content: unknown[], errorMessage: string): SessionEntry =>
    ({ id, type: 'message', message: { role: 'assistant', content, stopReason: 'error', errorMessage } }) as unknown as SessionEntry;
  const PARTIAL = [
    { type: 'thinking', thinking: 'Let me look' },
    { type: 'text', text: 'Reading the file' },
    { type: 'toolCall', id: 'never-ran', name: 'read', arguments: { path: '/a.ts' } },
  ];

  // The live adapter seals the partial message at its message_end and shows the card once pi moves past the call.
  it('replays what a failed call pi kept in context streamed, then its card, as the live view shows them', () => {
    const { messages } = reconstructMessages([userMsg('u1', 'hi'), failedWith('a1', PARTIAL, 'terminated')]);

    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'error']);
    expect(messages[1]).toMatchObject({ kind: 'assistant', content: 'Reading the file', thinking: 'Let me look' });
    expect(messages[2]).toEqual({ kind: 'error', content: 'terminated' });
  });

  // pi returns from the turn before executing any tool of an errored message (agent-loop.js:143-152), so the call never ran.
  it('replays the tool calls of a failed call as not executed, never as an outcome that was not recorded', () => {
    const { messages } = reconstructMessages([userMsg('u1', 'hi'), failedWith('a1', PARTIAL, 'terminated')]);

    const tools = messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []));
    expect(tools).toEqual([expect.objectContaining({ id: 'never-ran', abandoned: 'failed' })]);
    expect(tools[0]).not.toHaveProperty('result');
  });

  // pi returns before executing the tools of an aborted message too (agent-loop.js:143), and records the message (agent-session.js:764).
  it('replays the tool calls of an aborted call as not executed because the turn stopped, with no Stop record', () => {
    const aborted = { id: 'a1', type: 'message', message: { role: 'assistant', content: PARTIAL, stopReason: 'aborted', errorMessage: 'Request was aborted' } } as unknown as SessionEntry;
    const { messages } = reconstructMessages([userMsg('u1', 'hi'), aborted]);

    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []))).toEqual([expect.objectContaining({ id: 'never-ran', abandoned: 'stopped' })]);
  });

  // A failure after a Stop is its wind-down: the live view abandoned the call's cards at the Stop (markAborted).
  it('replays the tool calls of a Stop wind-down error as stopped, not failed', () => {
    const stop = { id: 'st1', type: 'custom', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: [], entryIds: ['a1'] } } as unknown as SessionEntry;
    const { messages } = reconstructMessages([userMsg('u1', 'hi'), failedWith('a1', PARTIAL, 'terminated'), stop]);

    expect(messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []))).toEqual([expect.objectContaining({ id: 'never-ran', abandoned: 'stopped' })]);
  });

  // The live adapter took back what an omitted call streamed (`assistantRetracted` at agent_end{willRetry} or the overflow compaction_start).
  it('replays nothing a call pi re-ran streamed, as the live view took it back', () => {
    const OVERFLOW = 'prompt is too long: 210000 tokens > 200000 maximum';
    const isOverflow = (message: { errorMessage?: string }): boolean => message.errorMessage === OVERFLOW;
    const retried = reconstructMessages([userMsg('u1', 'hi'), failedWith('a1', PARTIAL, '529 overloaded'), omitted('a1'), assistantMsg('a2', 'the answer')]);
    const overflowed = reconstructMessages([userMsg('u1', 'hi'), failedWith('a1', PARTIAL, OVERFLOW), omitted('a1')], undefined, isOverflow);

    expect(retried.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(retried.messages[1]).toMatchObject({ content: 'the answer' });
    expect(overflowed.messages.map((m) => m.kind)).toEqual(['user', 'error']);
  });

  it('a later edit that restores the call to model context shows its failure again', () => {
    const restored = { id: 'edit-2', type: 'context_edit', targetId: 'a1', replacement: { content: [{ type: 'text', text: 'x' }] } } as unknown as SessionEntry;
    expect(errors([userMsg('u1', 'hi'), failed('a1', '529 overloaded'), omitted('a1'), restored])).toEqual(['529 overloaded']);
  });

  describe('an overflow pi took out of context to recover it', () => {
    const OVERFLOW = 'prompt is too long: 210000 tokens > 200000 maximum';
    const isOverflow = (message: { errorMessage?: string }): boolean => message.errorMessage === OVERFLOW;
    const kinds = (branch: SessionEntry[]) => reconstructMessages(branch, undefined, isOverflow).messages.map((m) => m.kind);

    // _checkCompaction omits it (agent-session.js:2405-2406); _runAutoCompaction returns before compacting (:2465-2472) or its compaction throws (:2559-2581).
    it('shows its card when no compaction followed, as the live view does', () => {
      expect(reconstructMessages([userMsg('u1', 'hi'), failed('a1', OVERFLOW), omitted('a1')], undefined, isOverflow).messages
        .filter((m) => m.kind === 'error')).toEqual([{ kind: 'error', content: OVERFLOW }]);
    });

    // A recovered overflow is followed by the compaction (:2533) and the re-run call.
    it('shows the compaction and the re-run answer, not the overflow', () => {
      expect(kinds([userMsg('u1', 'hi'), failed('a1', OVERFLOW), omitted('a1'), compactionEntry('c1', 'sum'), assistantMsg('a2', 'the answer')]))
        .toEqual(['compaction', 'assistant']);
    });

    it('still hides a call pi retried, which is never an overflow', () => {
      expect(kinds([userMsg('u1', 'hi'), failed('a1', '529 overloaded'), omitted('a1')])).toEqual(['user']);
    });
  });

  describe('calls an abort skipped in a tool batch', () => {
    // pi finalizes the call it was running and starts none after it (agent-loop.js:402-404 sequential, :429-431 and
    // :449-451 parallel), persists only the finalized calls' results (:398-399, :453-458), and the next model call,
    // made under the aborted signal, ends aborted and is persisted (:141-152, agent-session.js:764); a request setup the signal rejects first ends it on an error stop instead (pi-ai lazy.js:41-44).
    const call = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}.ts` } });
    const batch = (id: string, ...ids: string[]) =>
      ({ id, type: 'message', message: { role: 'assistant', content: ids.map(call), stopReason: 'toolUse' } }) as unknown as SessionEntry;
    const result = (id: string, toolCallId: string) =>
      ({ id, type: 'message', message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'Operation aborted' }], isError: true } }) as unknown as SessionEntry;
    const abortedCall = (id: string) =>
      ({ id, type: 'message', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } }) as unknown as SessionEntry;
    const toolsOf = (branch: SessionEntry[]) => reconstructMessages(branch).messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []));

    it('replays them as not executed because the turn stopped when an aborted call follows', () => {
      const tools = toolsOf([userMsg('u1', 'go'), batch('a1', 'ran', 's1', 's2'), result('r1', 'ran'), abortedCall('a2')]);

      expect(tools.map((t) => [t.id, t.abandoned])).toEqual([['ran', undefined], ['s1', 'stopped'], ['s2', 'stopped']]);
      expect(tools[0]).toMatchObject({ isError: true });
    });

    // pi drains the steering queue into the transcript before that call (agent-loop.js:186, :116-121).
    // The wind-down record (`registerWindDownErrorRecord`) names the error whatever aborted the run, a Stop or not.
    it('replays them as stopped, with no card, when a wind-down error the record names follows', () => {
      const windDown = { id: 'a2', type: 'message', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' } } as unknown as SessionEntry;
      const record = { id: 'st1', type: 'custom', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: [], entryIds: ['a2'] } } as unknown as SessionEntry;
      const branch = [userMsg('u1', 'go'), batch('a1', 'ran', 's1'), result('r1', 'ran'), windDown, record];

      expect(toolsOf(branch).map((t) => [t.id, t.abandoned])).toEqual([['ran', undefined], ['s1', 'stopped']]);
      expect(reconstructMessages(branch).messages.filter((m) => m.kind === 'error')).toEqual([]);
    });

    it('replays them so when pi delivered a steer before the aborted call', () => {
      const tools = toolsOf([userMsg('u1', 'go'), batch('a1', 'ran', 's1'), result('r1', 'ran'), userMsg('u2', 'also c.ts'), abortedCall('a2')]);

      expect(tools.map((t) => [t.id, t.abandoned])).toEqual([['ran', undefined], ['s1', 'stopped']]);
    });

    it('leaves a call with no result unrecorded when no aborted call follows', () => {
      const tools = toolsOf([userMsg('u1', 'go'), batch('a1', 'ran', 's1'), result('r1', 'ran')]);

      expect(tools.find((t) => t.id === 's1')).not.toHaveProperty('abandoned');
    });

    // A cut batch always holds the result of the call pi was running, so a message with none is not one.
    it('leaves calls none of which has a result unrecorded even when an aborted call follows', () => {
      const tools = toolsOf([userMsg('u1', 'go'), batch('a1', 'x1', 'x2'), userMsg('u2', 'next'), abortedCall('a2')]);

      expect(tools.map((t) => t.abandoned)).toEqual([undefined, undefined]);
    });
  });

  // The live adapter shows the late tool_execution_end of a call pi executed, and drops one pi settled before execute.
  describe('a call a Stop cut short', () => {
    const call = (command: string) => ({ id: 'a1', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'slow', name: 'bash', arguments: { command } }] } }) as unknown as SessionEntry;
    const stop = { id: 'st1', type: 'custom', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: ['slow'], entryIds: [] } } as unknown as SessionEntry;
    const toolOf = (branch: SessionEntry[]) => reconstructMessages(branch).messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []))[0];

    it('replays a call pi executed with the result and time pi recorded for it', () => {
      const result = { id: 'r1', type: 'message', message: { role: 'toolResult', toolCallId: 'slow', content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true }, isError: true, durationMs: 4321 } } as unknown as SessionEntry;

      const tool = toolOf([userMsg('u1', 'go'), call('sleep 20'), result, stop]);
      expect(tool).toEqual({ id: 'slow', name: 'Bash', input: { command: 'sleep 20' }, result: 'Command aborted', isError: true, metadata: { damoclesCancelled: true }, durationMs: 4321 });
    });

    it('replays a call pi never executed as abandoned, without the result pi wrote while stopping', () => {
      const result = { id: 'r1', type: 'message', message: { role: 'toolResult', toolCallId: 'slow', content: [{ type: 'text', text: 'Operation aborted' }], details: {}, isError: true } } as unknown as SessionEntry;

      const tool = toolOf([userMsg('u1', 'go'), call('rm -rf build'), result, stop]);
      expect(tool).toEqual({ id: 'slow', name: 'Bash', input: { command: 'rm -rf build' }, abandoned: 'stopped' });
    });
  });
});

describe('loadPiSessionHistory — failed model calls', () => {
  beforeEach(() => {
    hoisted.branch = [];
  });

  it("judges an omitted call with pi-ai's overflow test, so an unrecovered overflow replays its card", async () => {
    const overflow = 'prompt is too long: 210000 tokens > 200000 maximum';
    hoisted.branch = [
      userMsg('u1', 'hi'),
      { id: 'a1', type: 'message', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: overflow } } as unknown as SessionEntry,
      { id: 'edit-a1', type: 'context_edit', targetId: 'a1', replacement: null } as unknown as SessionEntry,
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-overflow', (m) => posts.push(m));

    expect(posts.filter((p) => p.type === 'errorReplay')).toEqual([{ type: 'errorReplay', content: overflow }]);
  });
});

describe('reconstructMessages — mid-conversation system message', () => {
  it('produces no message for a role:"system" entry and keeps the surrounding messages in order', () => {
    const branch = [
      userMsg('u1', 'turn on plan mode'),
      systemMsg('s1', { damocles_plan_mode: 'Plan mode guidance.', damocles_tone: null }),
      assistantMsg('a1', 'plan mode is on'),
    ];
    const { messages } = reconstructMessages(branch);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect((messages[0] as { content: string }).content).toBe('turn on plan mode');
    expect((messages[1] as { content: string }).content).toBe('plan mode is on');
  });

  it('does not throw on a system entry whose sections patch is only removals', () => {
    expect(() => reconstructMessages([systemMsg('s1', { damocles_plan_mode: null })])).not.toThrow();
    expect(reconstructMessages([systemMsg('s1', { damocles_plan_mode: null })]).messages).toEqual([]);
  });
});

describe('loadPiSessionHistory — mid-conversation system message', () => {
  beforeEach(() => {
    hoisted.branch = [];
  });

  it('replays a transcript containing a system entry with no gap and no error', async () => {
    hoisted.branch = [
      userMsg('u1', 'first prompt'),
      assistantMsg('a1', 'first answer'),
      systemMsg('s1', { damocles_plan_mode: 'Plan mode guidance.' }),
      userMsg('u2', 'second prompt'),
      assistantMsg('a2', 'second answer'),
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-sys', (m) => posts.push(m));

    expect(posts.some((p) => p.type === 'errorReplay')).toBe(false);
    // Replay order is unbroken and the system entry consumes no prompt index.
    expect(posts.filter((p) => p.type === 'userReplay' || p.type === 'assistantReplay').map((p) => p.type)).toEqual([
      'userReplay',
      'assistantReplay',
      'userReplay',
      'assistantReplay',
    ]);
    const replays = posts.filter((p): p is Extract<ExtensionToWebviewMessage, { type: 'userReplay' }> => p.type === 'userReplay');
    expect(replays.map((r) => r.promptIndex)).toEqual([0, 1]);
    expect(replays.map((r) => r.content)).toEqual(['first prompt', 'second prompt']);
  });
});

describe('loadPiSessionHistory — rewindable ids', () => {
  const checkpoint = (userEntryId: string, turn: number): SessionEntry =>
    ({
      id: `cp-${turn}`,
      type: 'custom',
      customType: 'damocles-checkpoint',
      data: { v: 2, kind: 'checkpoint', turnId: `t${turn}`, userEntryId, beforeCommit: 'a', afterCommit: 'b', prompt: 'p', fileCount: 0, fileChanges: [], createdAt: '2026-01-01T00:00:00.000Z' },
    }) as unknown as SessionEntry;

  beforeEach(() => {
    vi.mocked(getCheckpointEntries).mockImplementation(realGetCheckpointEntries);
  });
  afterEach(() => {
    vi.mocked(getCheckpointEntries).mockImplementation(() => []);
    hoisted.branch = [];
  });

  it('resolves to the rewindable ids on the branch, and posts them', async () => {
    hoisted.branch = [
      userMsg('u1', 'one'),
      assistantMsg('a1', 'r1'),
      checkpoint('u1', 1),
      userMsg('u2', 'two'),
      assistantMsg('a2', 'r2'),
      checkpoint('u2', 2),
      checkpoint('u1', 3),
    ];
    const posts: ExtensionToWebviewMessage[] = [];

    const ids = await loadPiSessionHistory('/cwd', 'sess-cp', (m) => posts.push(m));

    expect(ids).toEqual(['u1', 'u2']);
    expect(posts.find((m) => m.type === 'checkpointInfo')).toEqual({ type: 'checkpointInfo', userMessageIds: ['u1', 'u2'] });
  });

  it('with no file checkpoints, resolves to every prompt on the branch, checkpointed or not, and posts them', async () => {
    hoisted.branch = [userMsg('u1', 'one'), assistantMsg('a1', 'r1'), checkpoint('u1', 1), userMsg('u2', 'two'), assistantMsg('a2', 'r2')];
    const posts: ExtensionToWebviewMessage[] = [];

    const ids = await loadPiSessionHistory('/cwd', 'sess-home', (m) => posts.push(m), undefined, undefined, false);

    expect(ids).toEqual(['u1', 'u2']);
    expect(posts.find((m) => m.type === 'checkpointInfo')).toEqual({ type: 'checkpointInfo', userMessageIds: ['u1', 'u2'] });
  });

  it('a replay superseded while it resolved the file posts no error and no done', async () => {
    const controller = new AbortController();
    vi.mocked(resolvePiSessionFile).mockImplementationOnce(async () => {
      controller.abort();
      return null;
    });
    const posts: ExtensionToWebviewMessage[] = [];

    expect(await loadPiSessionHistory('/cwd', 'sess-old', (m) => posts.push(m), controller.signal)).toBeNull();
    expect(posts.map((m) => m.type)).toEqual(['sessionCleared']);
  });

  it('resolves to null when the session file is missing', async () => {
    hoisted.branch = [userMsg('u1', 'one'), checkpoint('u1', 1)];
    vi.mocked(resolvePiSessionFile).mockResolvedValueOnce(null);

    expect(await loadPiSessionHistory('/cwd', 'sess-gone', () => {})).toBeNull();
  });

  it('a missing session file posts its notice in the UI language, then done', async () => {
    const greek = elBundle as Record<string, string>;
    const t = vi.spyOn(platform().localization, 't').mockImplementation((message) => greek[message] ?? message);
    vi.mocked(resolvePiSessionFile).mockResolvedValueOnce(null);
    const posts: ExtensionToWebviewMessage[] = [];
    try {
      await loadPiSessionHistory('/cwd', 'sess-gone', (m) => posts.push(m));
    } finally {
      t.mockRestore();
    }

    expect(posts.map((m) => m.type)).toEqual(['sessionCleared', 'errorReplay', 'done']);
    expect(posts[1]).toEqual({ type: 'errorReplay', content: 'Το αρχείο αυτής της συνομιλίας δεν βρέθηκε. Μπορεί να έχει διαγραφεί.' });
  });
});

describe('loadPiSessionHistory — when each replayed message was sent', () => {
  beforeEach(() => {
    hoisted.branch = [];
  });

  it("carries pi's message time, else the entry's time, on every userReplay, and none when the entry records neither", async () => {
    const withTimes = (entry: SessionEntry, entryTime: string | undefined, messageTime?: number): SessionEntry => {
      const raw = entry as unknown as { timestamp?: string; message?: { timestamp?: number } };
      if (entryTime !== undefined) raw.timestamp = entryTime;
      if (messageTime !== undefined && raw.message) raw.message.timestamp = messageTime;
      return entry;
    };
    hoisted.branch = [
      withTimes(userMsg('u1', 'first prompt'), '2026-06-20T20:00:00.000Z', Date.parse('2026-06-20T19:59:59.000Z')),
      withTimes(steerEntry('agent-7', 'steer message'), '2026-06-20T20:01:00.000Z'),
      withTimes(userMsg('u2', 'second prompt'), '2026-06-20T20:02:00.000Z'),
      withTimes(userMsg('u3', 'third prompt'), 'not a date'),
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-times', (m) => posts.push(m));

    const replays = posts.filter((p): p is Extract<ExtensionToWebviewMessage, { type: 'userReplay' }> => p.type === 'userReplay');
    expect(replays.map((r) => r.timestamp)).toEqual([
      Date.parse('2026-06-20T19:59:59.000Z'),
      Date.parse('2026-06-20T20:01:00.000Z'),
      Date.parse('2026-06-20T20:02:00.000Z'),
      undefined,
    ]);
    expect(replays.every((r) => !('timestamp' in r) || r.timestamp !== undefined)).toBe(true);
  });
});

describe('loadPiSessionHistory — steer chip replay (Slice 3)', () => {
  beforeEach(() => {
    hoisted.branch = [];
  });

  it('replays a steer chip in position without consuming a prompt index (rewind regression guard)', async () => {
    hoisted.branch = [
      userMsg('u1', 'first prompt'),
      steerEntry('agent-7', 'steer message', { agentType: 'coder', description: 'Build parser' }),
      userMsg('u2', 'second prompt'),
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-1', (m) => posts.push(m));

    const replays = posts.filter((p): p is Extract<ExtensionToWebviewMessage, { type: 'userReplay' }> => p.type === 'userReplay');
    expect(replays).toHaveLength(3);

    const [firstReal, steer, secondReal] = replays;
    // Real prompts keep their indices — the injected chip does NOT shift them.
    expect(firstReal).toMatchObject({ content: 'first prompt', promptIndex: 0 });
    expect(firstReal!.isInjected).toBeFalsy();
    expect(secondReal).toMatchObject({ content: 'second prompt', promptIndex: 1 });
    expect(secondReal!.isInjected).toBeFalsy();
    // The chip is injected, carries the steer target, and carries no index, as it does live.
    expect(steer!.content).toBe('steer message');
    expect(steer!.isInjected).toBe(true);
    expect(steer!.promptIndex).toBeUndefined();
    expect(steer!.steerTarget).toEqual({ agentId: 'agent-7', agentType: 'coder', description: 'Build parser' });
    // An entry written before steers carried images still replays, with no image blocks.
    expect(steer!.contentBlocks).toBeUndefined();
  });

  const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

  async function replaySteer(data: unknown): Promise<Array<Extract<ExtensionToWebviewMessage, { type: 'userReplay' }>>> {
    hoisted.branch = [userMsg('u1', 'first prompt'), steerEntry('agent-7', '', { data })];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-img', (m) => posts.push(m));
    return posts.filter((p): p is Extract<ExtensionToWebviewMessage, { type: 'userReplay' }> => p.type === 'userReplay');
  }

  it('replays an image steer with its images as contentBlocks', async () => {
    const replays = await replaySteer({ agentId: 'agent-7', message: 'look at this', images: [PNG, PNG] });
    expect(replays[1]).toMatchObject({ content: 'look at this', contentBlocks: [PNG, PNG], isInjected: true, steerTarget: { agentId: 'agent-7' } });
  });

  it('replays an image-only steer', async () => {
    const replays = await replaySteer({ agentId: 'agent-7', message: '', images: [PNG] });
    expect(replays[1]).toMatchObject({ content: '', contentBlocks: [PNG], steerTarget: { agentId: 'agent-7' } });
  });

  it.each([
    ['a malformed image', { agentId: 'agent-7', message: 'look', images: [{ type: 'image', source: { type: 'url' } }] }],
    ['an empty image list', { agentId: 'agent-7', message: 'look', images: [] }],
    ['a non-array', { agentId: 'agent-7', message: 'look', images: 'AAAA' }],
    ['neither text nor images', { agentId: 'agent-7', message: '' }],
  ])('rejects an entry with %s', async (_label, data) => {
    expect(await replaySteer(data)).toHaveLength(1);
  });
});

describe('loadPiSessionHistory — prompt index stamping', () => {
  afterEach(() => {
    hoisted.branch = [];
  });

  async function replays(branch: readonly SessionEntry[]): Promise<Array<Extract<ExtensionToWebviewMessage, { type: 'userReplay' }>>> {
    hoisted.branch = [...branch];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-idx', (m) => posts.push(m));
    return posts.filter((p): p is Extract<ExtensionToWebviewMessage, { type: 'userReplay' }> => p.type === 'userReplay');
  }

  async function replayedIndices(branch: readonly SessionEntry[]): Promise<Record<string, number | undefined>> {
    return Object.fromEntries((await replays(branch)).map((r) => [r.sdkMessageId ?? r.content, r.promptIndex]));
  }

  it('counts prompts a compaction hid and skips marked mid-run deliveries, so a reload stamps what the live prompt got', async () => {
    const indices = await replayedIndices(withPrompt(STORED_CONVERSATION, 'u-new', 'resumed prompt'));
    expect(indices['u2']).toBe(2);
    expect(indices['u-new']).toBe(STORED_PROMPT_COUNT);
  });

  // Live, a note's echo is injected and names no prompt; its marker makes the reload show it the same way.
  it('replays a marked cancel note as a mid-run delivery and a legacy one as the prompt it was counted as', async () => {
    const rows = await replays(STORED_CONVERSATION);
    const note = rows.find((r) => r.sdkMessageId === 'u-note')!;
    expect(note).toMatchObject({ content: 'the tests hung, skip them', isMidStream: true });
    expect(note.promptIndex).toBeUndefined();
    const legacy = rows.find((r) => r.sdkMessageId === 'u-note-legacy')!;
    expect(legacy.promptIndex).toBe(3);
    expect(legacy.isMidStream).toBeUndefined();
  });

  it('stamps a fork\'s resent prompt after the prompts it inherited', async () => {
    const indices = await replayedIndices(withPrompt(FORK_AT_SECOND_PROMPT, 'u-fork', 'resent'));
    expect(indices).toEqual({ u0: 0, 'u-fork': FORK_PROMPT_COUNT });
  });
});

describe('reconstructMessages — pruned screenshot', () => {
  const SCREENSHOT_PLACEHOLDER =
    '[Image removed: an older screenshot was pruned to keep the request within provider size limits. Capture a fresh screenshot (BrowserScreenshot) or re-read the file if this content is still needed.]';

  function screenshotTurn(): SessionEntry[] {
    return [
      userMsg('u1', 'take a screenshot'),
      {
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'browser_screenshot', arguments: { fullPage: false } }],
        },
      } as unknown as SessionEntry,
      {
        id: 'r1',
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'browser_screenshot',
          isError: false,
          content: [
            { type: 'text', text: 'Screenshot of https://example.com' },
            { type: 'image', data: 'BASE64', mimeType: 'image/jpeg' },
          ],
        },
      } as unknown as SessionEntry,
    ];
  }

  /**
   * The UI transcript is raw history, so it must keep showing what the tool returned even after the
   * image has left model context. Pinned here rather than left to the entry-type if-chain's silence.
   */
  it('ignores the context_edit that pruned the image', () => {
    const edit = {
      id: 'e1',
      type: 'context_edit',
      targetId: 'r1',
      replacement: { content: [{ type: 'text', text: SCREENSHOT_PLACEHOLDER }] },
    } as unknown as SessionEntry;

    const { messages } = reconstructMessages([...screenshotTurn(), edit]);

    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    const tools = (messages[1] as { tools: Array<{ id: string; result?: string }> }).tools;
    expect(tools[0]!.result).toBe('Screenshot of https://example.com');
    expect(JSON.stringify(messages)).not.toContain('[Image removed');
  });

  it('marks a successful image result with its count and never carries the base64', () => {
    const { messages } = reconstructMessages(screenshotTurn());
    const tools = (messages[1] as { tools: HistoryToolCall[] }).tools;
    expect(tools[0]).toMatchObject({ result: 'Screenshot of https://example.com', imageCount: 1 });
    expect(JSON.stringify(messages)).not.toContain('BASE64');
  });

  it('leaves imageCount off a failed or text-only result', () => {
    const firstTool = (branch: SessionEntry[]): HistoryToolCall =>
      (reconstructMessages(branch).messages[1] as { tools: HistoryToolCall[] }).tools[0]!;
    const withResult = (patch: Record<string, unknown>): SessionEntry[] => {
      const turn = screenshotTurn();
      const result = turn[2] as unknown as { message: Record<string, unknown> };
      result.message = { ...result.message, ...patch };
      return turn;
    };
    expect(firstTool(withResult({ isError: true }))).not.toHaveProperty('imageCount');
    expect(firstTool(withResult({ content: [{ type: 'text', text: 'ok' }] }))).not.toHaveProperty('imageCount');
  });
});

describe('loadPiSessionHistory — subagent cards from invocation entries and agent files', () => {
  const SESSION_ID = 'sess-agents';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-history-agents-'));
    hoisted.sessionDir = tmp;
    hoisted.branch = [];
  });
  afterEach(() => {
    hoisted.sessionDir = '/fake/dir';
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ts = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

  /** An agent pi session file as pi writes it: header, launch, then the given entries. */
  function writeAgentFile(fileId: string, agentId: string, extra: unknown[], launchExtra: Record<string, unknown> = {}): void {
    const dir = path.join(tmp, SESSION_ID, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const entries = [
      { type: 'session', version: 3, id: fileId, timestamp: ts(0), cwd: '/cwd' },
      {
        type: 'custom',
        id: 'l1',
        parentId: null,
        timestamp: ts(1),
        customType: DAMOCLES_AGENT_LAUNCH_ENTRY,
        data: { agentId, kind: 'subagent', agentType: 'Explore', description: 'look', prompt: 'look around', background: false, modelLabel: 'haiku', templatePath: '/a/explore.md', ...launchExtra },
      },
      ...extra,
    ];
    const lines = entries.map((e) => JSON.stringify(e)).join(String.fromCharCode(10));
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_${fileId}.jsonl`), lines);
  }

  const agentCall = (id: string, toolCallId: string, background = false): SessionEntry =>
    ({
      id,
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: toolCallId, name: 'Agent', arguments: { description: 'look', prompt: 'look around', subagent_type: 'Explore', run_in_background: background } },
        ],
      },
    }) as unknown as SessionEntry;
  const invocation = (agentId: string, toolCallId: string): SessionEntry =>
    ({ id: `i-${agentId}`, type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: agentId, toolCallId, resume: false } }) as unknown as SessionEntry;
  const agentResult = (toolCallId: string, text: string, details: unknown): SessionEntry =>
    ({ id: `r-${toolCallId}`, type: 'message', message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text }], isError: false, details } }) as unknown as SessionEntry;

  async function replayedAgentTools(): Promise<HistoryToolCall[]> {
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', SESSION_ID, (m) => posts.push(m));
    return posts.flatMap((p) => (p.type === 'assistantReplay' ? (p.tools ?? []) : [])).filter((t) => t.name === 'Agent');
  }

  it('hydrates a nested tool result with its image count and never its base64', async () => {
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: ts(3),
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'n1', name: 'read', arguments: { path: 'a.png' } }] },
      },
      {
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: ts(4),
        message: { role: 'toolResult', toolCallId: 'n1', content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'NESTEDPNG', mimeType: 'image/png' }] },
      },
    ]);
    hoisted.branch = [userMsg('u1', 'explore it'), agentCall('a1', 'tc1'), invocation('agent-1', 'tc1')];

    const [tool] = await replayedAgentTools();
    const nested = tool!.agentMessages!.flatMap((m) => m.contentBlocks).find((b) => b.type === 'tool_use');
    expect(nested).toMatchObject({ id: 'n1', result: 'Read image file [image/png]', imageCount: 1 });
    expect(JSON.stringify(tool)).not.toContain('NESTEDPNG');
  });

  // The nested extension records a call the abort settled at the gate (agent-loop.js:500-504) before pi writes its result.
  it('replays a nested call its aborted run settled before it ran as not executed, as the live card showed it', async () => {
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'n1', name: 'bash', arguments: { command: 'rm -rf build' } }], stopReason: 'toolUse' } },
      { type: 'custom', id: 's1', parentId: 'm2', timestamp: ts(4), customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: ['n1'], entryIds: [] } },
      { type: 'message', id: 'm3', parentId: 's1', timestamp: ts(4), message: { role: 'toolResult', toolCallId: 'n1', content: [{ type: 'text', text: 'Operation aborted' }], details: {}, isError: true } },
    ]);
    hoisted.branch = [userMsg('u1', 'explore it'), agentCall('a1', 'tc1'), invocation('agent-1', 'tc1')];

    const [tool] = await replayedAgentTools();
    const nested = tool!.agentMessages!.flatMap((m) => m.contentBlocks).find((b) => b.type === 'tool_use');
    expect(nested).toEqual({ type: 'tool_use', id: 'n1', name: 'Bash', input: { command: 'rm -rf build' }, abandoned: 'stopped' });
  });

  // The nested extension records an error stop that ended under the aborted signal (`registerWindDownErrorRecord`).
  it('replays no error card for a nested wind-down error the record names, and keeps one it does not name', async () => {
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: ts(3), message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded_error' } },
      { type: 'message', id: 'm3', parentId: 'm2', timestamp: ts(4), message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' } },
      { type: 'custom', id: 's1', parentId: 'm3', timestamp: ts(4), customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: [], entryIds: ['m3'] } },
    ]);
    hoisted.branch = [userMsg('u1', 'explore it'), agentCall('a1', 'tc1'), invocation('agent-1', 'tc1')];

    const [tool] = await replayedAgentTools();
    expect(tool!.agentMessages!.filter((m) => m.role === 'error')).toEqual([{ role: 'error', contentBlocks: [{ type: 'text', text: '529 overloaded_error' }] }]);
  });

  it("replays each tool's recorded execution time, main and nested, and none for a result recorded without one", async () => {
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: ts(3),
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'n1', name: 'read', arguments: { path: 'a.ts' } }] },
      },
      { type: 'message', id: 'm3', parentId: 'm2', timestamp: ts(4), message: { role: 'toolResult', toolCallId: 'n1', content: [{ type: 'text', text: 'body' }], durationMs: 42 } },
    ]);
    const timedCall = { id: 'a0', type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'timed', name: 'bash', arguments: { command: 'ls' } },
      { type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'pwd' } },
    ] } } as unknown as SessionEntry;
    const timedResult = { id: 'r0', type: 'message', message: { role: 'toolResult', toolCallId: 'timed', content: [{ type: 'text', text: 'a' }], isError: false, durationMs: 1234 } } as unknown as SessionEntry;
    const oldResult = { id: 'r00', type: 'message', message: { role: 'toolResult', toolCallId: 'old', content: [{ type: 'text', text: '/' }], isError: false } } as unknown as SessionEntry;
    const branch = [userMsg('u1', 'explore it'), timedCall, timedResult, oldResult, agentCall('a1', 'tc1'), invocation('agent-1', 'tc1')];
    hoisted.branch = branch;

    const { messages } = reconstructMessages(branch);
    const mainTools = messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []));
    expect(mainTools.find((t) => t.id === 'timed')).toMatchObject({ durationMs: 1234 });
    expect(mainTools.find((t) => t.id === 'old')).not.toHaveProperty('durationMs');

    const [tool] = await replayedAgentTools();
    const nested = tool!.agentMessages!.flatMap((m) => m.contentBlocks).find((b) => b.type === 'tool_use');
    expect(nested).toMatchObject({ id: 'n1', durationMs: 42 });
  });

  it('rebuilds a card from its invocation entry and the agent’s pi session file', async () => {
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: ts(3),
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'n1', name: 'read', arguments: { path: 'a.ts' } }] },
      },
      { type: 'message', id: 'm3', parentId: 'm2', timestamp: ts(4), message: { role: 'toolResult', toolCallId: 'n1', content: [{ type: 'text', text: 'body' }] } },
      { type: 'message', id: 'm4', parentId: 'm3', timestamp: ts(5), message: { role: 'assistant', content: [{ type: 'text', text: 'all found' }] } },
      { type: 'custom', id: 's1', parentId: 'm4', timestamp: ts(6), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'completed', result: 'all found' } },
    ]);
    hoisted.branch = [
      userMsg('u1', 'explore it'),
      agentCall('a1', 'tc1'),
      invocation('agent-1', 'tc1'),
      agentResult('tc1', '{"agentId":"agent-1"}', { agentId: 'agent-1', status: 'completed' }),
    ];

    const [tool] = await replayedAgentTools();
    expect(tool).toMatchObject({
      sdkAgentId: 'agent-1',
      agentStatus: 'completed',
      agentResultText: 'all found',
      agentModel: 'haiku',
      agentTemplatePath: '/a/explore.md',
      agentToolCount: 1,
      agentStartTimestamp: Date.parse(ts(1)),
      agentEndTimestamp: Date.parse(ts(6)),
    });
    expect(tool!.agentMessages!.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(tool!.agentMessages![1]!.contentBlocks[0]).toMatchObject({ type: 'tool_use', id: 'n1', result: 'body' });
  });

  it('replays a call pi retried as nothing and a call that failed for good with its error, as the live card showed them', async () => {
    const failed = (text: string, errorMessage: string) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'error', errorMessage });
    writeAgentFile('agent-1', 'agent-1', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: ts(3), message: failed('Let me', '529 overloaded_error') },
      // `_prepareRetry` omits the attempt it re-runs (`agent-session.js:3048`).
      { type: 'context_edit', id: 'c1', parentId: 'm2', timestamp: ts(3), targetId: 'm2', replacement: null },
      { type: 'message', id: 'm3', parentId: 'c1', timestamp: ts(4), message: failed('Now I will', '400 invalid_request_error') },
      { type: 'custom', id: 's1', parentId: 'm3', timestamp: ts(5), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'error', result: '400 invalid_request_error' } },
    ]);
    hoisted.branch = [userMsg('u1', 'explore it'), agentCall('a1', 'tc1'), invocation('agent-1', 'tc1')];

    const [tool] = await replayedAgentTools();
    expect(tool!.agentMessages).toEqual([
      { role: 'user', contentBlocks: [{ type: 'text', text: 'look around' }] },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: 'Now I will' }] },
      { role: 'error', contentBlocks: [{ type: 'text', text: '400 invalid_request_error' }] },
    ]);
  });

  it('a background agent that failed before its task was committed takes its error from the injection details', async () => {
    hoisted.branch = [
      userMsg('u1', 'explore in the background'),
      agentCall('a1', 'tc2', true),
      invocation('agent-2', 'tc2'),
      agentResult('tc2', '{"status":"async_launched","agentId":"agent-2"}', { agentId: 'agent-2', status: 'async_launched' }),
      {
        id: 'inj',
        type: 'custom_message',
        customType: 'damocles-subagent-results',
        content: 'The background subagent you launched has finished.',
        display: false,
        details: { agents: [{ agentId: 'agent-2', toolCallId: 'tc2', status: 'error', result: 'Model x is not signed in.' }] },
      } as unknown as SessionEntry,
    ];

    const [tool] = await replayedAgentTools();
    expect(tool).toMatchObject({ sdkAgentId: 'agent-2', agentStatus: 'error', agentResultText: 'Model x is not signed in.' });
    expect(tool!.agentMessages).toBeUndefined();
  });

  it('an agent killed before any status was recorded replays as interrupted', async () => {
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc3', true), invocation('agent-3', 'tc3')];
    const [tool] = await replayedAgentTools();
    expect(tool).toMatchObject({ sdkAgentId: 'agent-3', agentStatus: 'interrupted' });
  });

  it('a resume call gets its own card with only its segment; the original card keeps its stop', async () => {
    writeAgentFile('agent-5', 'agent-5', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: 'first half' }] } },
      { type: 'custom', id: 's1', parentId: 'm2', timestamp: ts(4), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'stopped', stopReason: 'user', result: 'first half' } },
      { type: 'custom', id: 'g1', parentId: 's1', timestamp: ts(10), customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: { toolCallId: 'tc-r', message: 'finish it' } },
      { type: 'message', id: 'm3', parentId: 'g1', timestamp: ts(11), message: { role: 'user', content: 'continue' } },
      { type: 'message', id: 'm4', parentId: 'm3', timestamp: ts(12), message: { role: 'assistant', content: [{ type: 'text', text: 'second half' }] } },
      { type: 'custom', id: 's2', parentId: 'm4', timestamp: ts(13), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'completed', result: 'second half' } },
    ]);
    hoisted.branch = [
      userMsg('u1', 'explore it'),
      agentCall('a1', 'tc5'),
      invocation('agent-5', 'tc5'),
      agentResult('tc5', 'first half', { agentId: 'agent-5', status: 'stopped', stopReason: 'user' }),
      userMsg('u2', 'continue'),
      {
        id: 'a2',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-r', name: 'Agent', arguments: { resume: 'agent-5', message: 'finish it' } }] },
      } as unknown as SessionEntry,
      { id: 'i-r', type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-5', toolCallId: 'tc-r', resume: true } } as unknown as SessionEntry,
      agentResult('tc-r', 'second half', { agentId: 'agent-5', status: 'completed' }),
    ];

    const [original, resumed] = await replayedAgentTools();

    expect(original).toMatchObject({ id: 'tc5', sdkAgentId: 'agent-5', agentStatus: 'stopped', agentResultText: 'first half' });
    expect(original!.agentResumedFrom).toBeUndefined();
    expect(original!.agentMessages!.flatMap((m) => m.contentBlocks)).toEqual([
      { type: 'text', text: 'look around' },
      { type: 'text', text: 'first half' },
    ]);
    expect(original!.agentEndTimestamp).toBe(Date.parse(ts(4)));

    expect(resumed).toMatchObject({
      id: 'tc-r',
      sdkAgentId: 'agent-5',
      agentResumedFrom: 'agent-5',
      agentStatus: 'completed',
      agentResultText: 'second half',
      agentLaunch: { agentType: 'Explore', description: 'look', prompt: 'look around', background: false },
      agentStartTimestamp: Date.parse(ts(10)),
    });
    expect(resumed!.agentMessages!.flatMap((m) => m.contentBlocks)).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: 'second half' },
    ]);
  });

  it('gives each card the usage of its own segment, cache warms and compactions included, and the launch billing flag', async () => {
    const u = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) =>
      ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
    writeAgentFile('agent-6', 'agent-6', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'user', content: 'look around' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: 'first half' }], usage: u(10, 20, 300, 40, 0.5) } },
      { type: 'usage', id: 'w1', parentId: 'm2', timestamp: ts(4), kind: 'cache_warm', provider: 'anthropic', model: 'claude', usage: u(0, 1, 900, 0, 0.05) },
      { type: 'custom', id: 's1', parentId: 'w1', timestamp: ts(5), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'stopped', stopReason: 'user', result: 'first half' } },
      { type: 'custom', id: 'g1', parentId: 's1', timestamp: ts(10), customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: { toolCallId: 'tc-r6' } },
      { type: 'compaction', id: 'c1', parentId: 'g1', timestamp: ts(11), summary: 's', firstKeptEntryId: 'm2', tokensBefore: 5000, usage: u(4000, 600, 0, 0, 0.2) },
      { type: 'message', id: 'm3', parentId: 'c1', timestamp: ts(12), message: { role: 'assistant', content: [{ type: 'text', text: 'second half' }], usage: u(1, 2, 330, 4, 0.25) } },
    ], { dollarBilled: false });
    hoisted.branch = [
      userMsg('u1', 'explore it'),
      agentCall('a1', 'tc6'),
      invocation('agent-6', 'tc6'),
      {
        id: 'a2',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-r6', name: 'Agent', arguments: { resume: 'agent-6' } }] },
      } as unknown as SessionEntry,
      { id: 'i-r6', type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-6', toolCallId: 'tc-r6', resume: true } } as unknown as SessionEntry,
    ];

    const [original, resumed] = await replayedAgentTools();

    expect(original!.agentUsage).toEqual({ totalInputTokens: 10, totalOutputTokens: 21, cacheReadTokens: 1200, cacheCreationTokens: 40, costUsd: expect.closeTo(0.55) });
    expect(resumed!.agentUsage).toEqual({ totalInputTokens: 4001, totalOutputTokens: 602, cacheReadTokens: 330, cacheCreationTokens: 4, costUsd: expect.closeTo(0.45) });
    expect(original!.agentDollarBilled).toBe(false);
    expect(resumed!.agentDollarBilled).toBe(false);
  });

  it('a launch recorded before the billing flag leaves the card to the panel flag', async () => {
    writeAgentFile('agent-7', 'agent-7', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc7'), invocation('agent-7', 'tc7')];
    const [tool] = await replayedAgentTools();
    expect(tool).not.toHaveProperty('agentDollarBilled');
  });

  it('a resume card takes the billing flag its segment recorded over the launch flag, or the lack of one', async () => {
    writeAgentFile('agent-8', 'agent-8', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'first half' }] } },
      { type: 'custom', id: 'g1', parentId: 'm1', timestamp: ts(10), customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: { toolCallId: 'tc-r8', dollarBilled: true } },
      { type: 'message', id: 'm2', parentId: 'g1', timestamp: ts(12), message: { role: 'assistant', content: [{ type: 'text', text: 'second half' }] } },
    ]);
    hoisted.branch = [
      userMsg('u1', 'go'),
      agentCall('a1', 'tc8'),
      invocation('agent-8', 'tc8'),
      {
        id: 'a2',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-r8', name: 'Agent', arguments: { resume: 'agent-8' } }] },
      } as unknown as SessionEntry,
      { id: 'i-r8', type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-8', toolCallId: 'tc-r8', resume: true } } as unknown as SessionEntry,
    ];

    const [original, resumed] = await replayedAgentTools();

    expect(original).not.toHaveProperty('agentDollarBilled');
    expect(resumed!.agentDollarBilled).toBe(true);
  });

  it('gives each card the effort its own run recorded: the launch for the spawn, the segment for a resume', async () => {
    writeAgentFile('agent-9', 'agent-9', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'first half' }] } },
      { type: 'custom', id: 'g1', parentId: 'm1', timestamp: ts(10), customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: { toolCallId: 'tc-r9', effort: 'high' } },
      { type: 'message', id: 'm2', parentId: 'g1', timestamp: ts(12), message: { role: 'assistant', content: [{ type: 'text', text: 'second half' }] } },
    ], { effort: 'medium' });
    hoisted.branch = [
      userMsg('u1', 'go'),
      agentCall('a1', 'tc9'),
      invocation('agent-9', 'tc9'),
      {
        id: 'a2',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-r9', name: 'Agent', arguments: { resume: 'agent-9' } }] },
      } as unknown as SessionEntry,
      { id: 'i-r9', type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-9', toolCallId: 'tc-r9', resume: true } } as unknown as SessionEntry,
    ];

    const [original, resumed] = await replayedAgentTools();

    expect(original!.agentEffort).toBe('medium');
    expect(resumed!.agentEffort).toBe('high');
  });

  it('a resume card whose segment recorded no effort, or that has no segment, shows none, as its live card did', async () => {
    writeAgentFile('agent-11', 'agent-11', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'first half' }] } },
      { type: 'custom', id: 'g1', parentId: 'm1', timestamp: ts(10), customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: { toolCallId: 'tc-r11' } },
      { type: 'message', id: 'm2', parentId: 'g1', timestamp: ts(12), message: { role: 'assistant', content: [{ type: 'text', text: 'second half' }] } },
    ], { effort: 'medium' });
    const resumeCall = (entryId: string, toolCallId: string): SessionEntry[] => [
      { id: entryId, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'Agent', arguments: { resume: 'agent-11' } }] } } as unknown as SessionEntry,
      { id: `i-${toolCallId}`, type: 'custom', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-11', toolCallId, resume: true } } as unknown as SessionEntry,
    ];
    // tc-r11b was killed before its session existed, so it opened no segment.
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc11'), invocation('agent-11', 'tc11'), ...resumeCall('a2', 'tc-r11'), ...resumeCall('a3', 'tc-r11b')];

    const [original, resumed, killed] = await replayedAgentTools();

    expect(original!.agentEffort).toBe('medium');
    expect(resumed).not.toHaveProperty('agentEffort');
    expect(killed).not.toHaveProperty('agentEffort');
  });

  it('a launch recorded before effort, or for a model that does not reason, shows no effort', async () => {
    writeAgentFile('agent-10', 'agent-10', [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc10'), invocation('agent-10', 'tc10')];
    const [tool] = await replayedAgentTools();
    expect(tool).not.toHaveProperty('agentEffort');
  });

  it("replays a reply's effort through the registry lookup the host resolves", async () => {
    hoisted.branch = [
      userMsg('u1', 'go'),
      { id: 'a1', type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'high', content: [{ type: 'text', text: 'done' }] } } as unknown as SessionEntry,
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', SESSION_ID, (m) => posts.push(m), undefined, Promise.resolve(() => true));
    expect(posts.find((p) => p.type === 'assistantReplay')).toMatchObject({ content: 'done', effort: 'high' });
  });

  it('display:false custom messages, such as the interruption notice, render nothing', async () => {
    hoisted.branch = [
      userMsg('u1', 'go'),
      { id: 'n1', type: 'custom_message', customType: 'damocles-interruption-notice', content: 'These agents were interrupted', display: false } as unknown as SessionEntry,
      assistantMsg('a1', 'done'),
    ];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', SESSION_ID, (m) => posts.push(m));
    expect(JSON.stringify(posts)).not.toContain('These agents were interrupted');
  });

  it('starts every agent file read before the first one settles, and hydrates each card from its own file', async () => {
    const statusOnly = (text: string) => [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text }] } },
      { type: 'custom', id: 's1', parentId: 'm1', timestamp: ts(3), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'completed', result: text } },
    ];
    writeAgentFile('agent-a', 'agent-a', statusOnly('found a'));
    writeAgentFile('agent-b', 'agent-b', statusOnly('found b'));
    hoisted.branch = [
      userMsg('u1', 'explore both'),
      agentCall('a1', 'tc-a'),
      invocation('agent-a', 'tc-a'),
      agentCall('a2', 'tc-b'),
      invocation('agent-b', 'tc-b'),
    ];
    const actual = await vi.importActual<typeof import('../../agent-records')>('../../agent-records');
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(readAgentFile).mockImplementation(async (p) => {
      started.push(p);
      await gate;
      return actual.readAgentFile(p);
    });

    try {
      const replay = replayedAgentTools();
      await vi.waitFor(() => expect(started).toHaveLength(2));
      release();
      const tools = await replay;

      expect(tools.map((t) => [t.sdkAgentId, t.agentStatus, t.agentResultText])).toEqual([
        ['agent-a', 'completed', 'found a'],
        ['agent-b', 'completed', 'found b'],
      ]);
    } finally {
      vi.mocked(readAgentFile).mockImplementation(actual.readAgentFile);
    }
  });

  it('reads at most eight agent files at once, and hydrates every card in order', async () => {
    const statusOnly = (text: string) => [
      { type: 'message', id: 'm1', parentId: 'l1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text }] } },
      { type: 'custom', id: 's1', parentId: 'm1', timestamp: ts(3), customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'completed', result: text } },
    ];
    const ids = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    hoisted.branch = [userMsg('u1', 'explore all')];
    for (const id of ids) {
      writeAgentFile(id, id, statusOnly(`found ${id}`));
      hoisted.branch.push(agentCall(`a-${id}`, `tc-${id}`), invocation(id, `tc-${id}`));
    }
    const actual = await vi.importActual<typeof import('../../agent-records')>('../../agent-records');
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(readAgentFile).mockImplementation(async (p) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return actual.readAgentFile(p);
    });

    try {
      const replay = replayedAgentTools();
      await vi.waitFor(() => expect(inFlight).toBe(8));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(inFlight).toBe(8);
      release();
      const tools = await replay;

      expect(peak).toBe(8);
      expect(tools.map((t) => [t.sdkAgentId, t.agentResultText])).toEqual(ids.map((id) => [id, `found ${id}`]));
    } finally {
      vi.mocked(readAgentFile).mockImplementation(actual.readAgentFile);
    }
  });

  it('a session recorded before agent files shows only the parent tool call and result', async () => {
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc4'), agentResult('tc4', '{"agentId":"old"}', undefined)];
    const [tool] = await replayedAgentTools();
    expect(tool!.result).toBe('{"agentId":"old"}');
    expect(tool!.sdkAgentId).toBeUndefined();
    expect(tool!.agentStatus).toBeUndefined();
    expect(tool!.agentMessages).toBeUndefined();
  });
});

describe('loadPiSessionHistory — usage totals', () => {
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const entry = (id: string, timestamp: string, message: unknown): SessionEntry =>
    ({ id, type: 'message', timestamp, message }) as unknown as SessionEntry;

  // Two turns; the rewound request is off the branch but was billed, so it is in the file total.
  const u1 = entry('u1', '2026-01-01T10:00:00.000Z', { role: 'user', content: [{ type: 'text', text: 'one' }] });
  const a1 = entry('a1', '2026-01-01T10:00:01.000Z', { role: 'assistant', content: [{ type: 'text', text: 'r1' }], usage: usage(10, 5, 100, 20, 1) });
  const rewound = entry('ax', '2026-01-01T10:00:02.000Z', { role: 'assistant', content: [], stopReason: 'aborted', usage: usage(1, 1, 0, 0, 0.5) });
  const u2 = entry('u2', '2026-01-01T12:00:00.000Z', { role: 'user', content: [{ type: 'text', text: 'two' }] });
  const a2 = entry('a2', '2026-01-01T12:00:01.000Z', { role: 'assistant', content: [{ type: 'text', text: 'r2' }], usage: usage(2, 7, 130, 0, 0.25) });
  const warm = { id: 'w', type: 'usage', timestamp: '2026-01-01T12:05:00.000Z', kind: 'cache_warm', usage: usage(0, 1, 130, 0, 0.125) } as unknown as SessionEntry;

  afterEach(() => {
    hoisted.entries = null;
    hoisted.headerTimestamp = undefined;
  });

  async function replaySessionUsage(): Promise<Extract<ExtensionToWebviewMessage, { type: 'sessionUsage' }>> {
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-usage', (m) => posts.push(m));
    const types = posts.map((m) => m.type);
    // The totals land before `done`, which ends the replay and carries none.
    expect(types.indexOf('sessionUsage')).toBeLessThan(types.indexOf('done'));
    expect(posts.find((m) => m.type === 'done')).toEqual({ type: 'done', data: { type: 'result', session_id: 'sess-usage', is_done: true } });
    return posts.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'sessionUsage' }> => m.type === 'sessionUsage')!;
  }

  it('sums every billed entry in the file, and counts the branch prompts', async () => {
    hoisted.branch = [u1, a1, u2, a2];
    hoisted.entries = [u1, a1, rewound, u2, a2, warm];
    expect(await replaySessionUsage()).toEqual({
      type: 'sessionUsage',
      usage: { totalInputTokens: 13, totalOutputTokens: 14, cacheReadTokens: 360, cacheCreationTokens: 20, costUsd: 1.875 },
      numTurns: 2,
    });
  });

  it('keeps the context snapshot at the last request', async () => {
    hoisted.branch = [u1, a1, u2, a2];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-usage', (m) => posts.push(m));
    expect(posts.find((m) => m.type === 'tokenUsageUpdate')).toEqual({ type: 'tokenUsageUpdate', inputTokens: 2, cacheReadTokens: 130, cacheCreationTokens: 0 });
  });

  it('keeps the context snapshot on the last good request after an aborted or errored one', async () => {
    const failed = entry('ae', '2026-01-01T12:00:02.000Z', { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded', usage: usage(0, 0, 0, 0, 0) });
    hoisted.branch = [u1, a1, u2, a2, rewound, failed];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-usage', (m) => posts.push(m));
    expect(posts.find((m) => m.type === 'tokenUsageUpdate')).toEqual({ type: 'tokenUsageUpdate', inputTokens: 2, cacheReadTokens: 130, cacheCreationTokens: 0 });
  });

  it('resets the context snapshot at a compaction until a response follows it', async () => {
    const compaction = { id: 'c1', type: 'compaction', timestamp: '2026-01-01T12:10:00.000Z', summary: 's', firstKeptEntryId: 'u2', tokensBefore: 5000 } as unknown as SessionEntry;
    hoisted.branch = [u1, a1, u2, a2, compaction];
    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-usage', (m) => posts.push(m));
    expect(posts.find((m) => m.type === 'tokenUsageUpdate')).toEqual({ type: 'tokenUsageUpdate', inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

    const a3 = entry('a3', '2026-01-01T12:11:00.000Z', { role: 'assistant', content: [{ type: 'text', text: 'r3' }], usage: usage(4, 1, 50, 6, 0.1) });
    hoisted.branch = [u1, a1, u2, a2, compaction, a3];
    const after: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory('/cwd', 'sess-usage', (m) => after.push(m));
    expect(after.find((m) => m.type === 'tokenUsageUpdate')).toEqual({ type: 'tokenUsageUpdate', inputTokens: 4, cacheReadTokens: 50, cacheCreationTokens: 6 });
  });

  it('counts only the entries a fork wrote', async () => {
    hoisted.branch = [u1, a1, u2, a2];
    hoisted.entries = [u1, a1, rewound, u2, a2, warm];
    hoisted.headerTimestamp = '2026-01-01T11:00:00.000Z';
    expect(await replaySessionUsage()).toEqual({
      type: 'sessionUsage',
      usage: { totalInputTokens: 2, totalOutputTokens: 8, cacheReadTokens: 260, cacheCreationTokens: 0, costUsd: 0.375 },
      numTurns: 1,
    });
  });
});
