import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

// Hermetic fixtures for driving loadPiSessionHistory without the real pi runtime or filesystem.
const hoisted = vi.hoisted(() => ({ branch: [] as unknown[] }));
vi.mock('../../pi-loader', () => ({
  initPiLoader: vi.fn(async () => ({
    SessionManager: { open: () => ({ getLeafId: () => 'leaf', getBranch: () => hoisted.branch }) },
  })),
}));
vi.mock('../reading', () => ({ resolvePiSessionFile: vi.fn(async () => '/fake/session.jsonl') }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: vi.fn(() => '/fake/dir') }));
vi.mock('../../checkpoints', () => ({ getCheckpointEntries: vi.fn(() => []) }));
vi.mock('../../subagents/output-file', () => ({ readSubagentTranscripts: vi.fn(async () => new Map()) }));
vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { reconstructMessages, loadPiSessionHistory } from '../history-loader';
import { stripIdeContext } from '../ide-context';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY, DAMOCLES_STEER_ENTRY } from '../constants';

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

describe('stripIdeContext', () => {
  it('strips a merged opened-file wrapper, keeping the real message (pi merges adjacent text blocks)', () => {
    const stored =
      '<ide_opened_file>The user opened the file c:\\x.jsonl in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it';
    expect(stripIdeContext(stored)).toBe('what day is it');
  });

  it('strips a multi-line selection wrapper, keeping the real message', () => {
    const stored =
      '<ide_selection>The user selected the lines 1 to 5 from x.ts:\nconst a = 1;\n\nThis may or may not be related to the current task.</ide_selection>\nfix this';
    expect(stripIdeContext(stored)).toBe('fix this');
  });

  it('reduces a standalone wrapper block (image-message case) to empty', () => {
    expect(stripIdeContext('<ide_opened_file>x</ide_opened_file>')).toBe('');
  });

  it('leaves a normal message untouched', () => {
    expect(stripIdeContext('just a normal message')).toBe('just a normal message');
  });

  it('only strips a leading wrapper — a closing tag a user typed mid-message survives', () => {
    const text = 'please keep this </ide_opened_file> literal mid-text';
    expect(stripIdeContext(text)).toBe(text);
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

  it('a session with no compaction is unaffected', () => {
    const branch = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    const { messages } = reconstructMessages(branch);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
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
    // The chip is injected, carries the steer target, and shares the un-incremented index (consumes none).
    expect(steer!.content).toBe('steer message');
    expect(steer!.isInjected).toBe(true);
    expect(steer!.promptIndex).toBe(1);
    expect(steer!.steerTarget).toEqual({ agentId: 'agent-7', agentType: 'coder', description: 'Build parser' });
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
});
