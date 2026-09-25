import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { HistoryToolCall } from '@shared/types/content';

// Hermetic fixtures for driving loadPiSessionHistory without the real pi runtime. Agent files are real
// JSONL under a temp session dir, parsed by pi's own `parseSessionEntries`.
const hoisted = vi.hoisted(() => ({ branch: [] as unknown[], sessionDir: '/fake/dir' }));
vi.mock('../../pi-loader', async () => {
  const real = await import('@earendil-works/pi-coding-agent');
  return {
    initPiLoader: vi.fn(async () => ({
      SessionManager: { open: () => ({ getLeafId: () => 'leaf', getBranch: () => hoisted.branch }) },
      parseSessionEntries: real.parseSessionEntries,
    })),
  };
});
vi.mock('../reading', () => ({ resolvePiSessionFile: vi.fn(async () => '/fake/session.jsonl') }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: vi.fn(() => hoisted.sessionDir) }));
vi.mock('../../checkpoints', () => ({ getCheckpointEntries: vi.fn(() => []) }));
vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { reconstructMessages, loadPiSessionHistory } from '../history-loader';
import { stripIdeContext } from '../ide-context';
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_SEGMENT_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
  DAMOCLES_STEER_ENTRY,
} from '../constants';

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
  function writeAgentFile(fileId: string, agentId: string, extra: unknown[]): void {
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
        data: { agentId, kind: 'subagent', agentType: 'Explore', description: 'look', prompt: 'look around', background: false, modelLabel: 'haiku', templatePath: '/a/explore.md' },
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

  it('a background agent that failed before its first response takes its error from the injection details', async () => {
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

  it('a session recorded before agent files shows only the parent tool call and result', async () => {
    hoisted.branch = [userMsg('u1', 'go'), agentCall('a1', 'tc4'), agentResult('tc4', '{"agentId":"old"}', undefined)];
    const [tool] = await replayedAgentTools();
    expect(tool!.result).toBe('{"agentId":"old"}');
    expect(tool!.sdkAgentId).toBeUndefined();
    expect(tool!.agentStatus).toBeUndefined();
    expect(tool!.agentMessages).toBeUndefined();
  });
});
