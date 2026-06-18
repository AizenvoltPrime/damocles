import { describe, it, expect, afterAll, vi } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';

// Point the Damocles home dir at a throwaway temp dir so transcript reads/writes never touch the real
// ~/.damocles tree. The async factory is hoisted above the output-file import, so it sees the temp dir.
vi.mock('../../../auth/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(join(tmpdir(), 'damocles-subagent-transcripts-')) };
});

import { DAMOCLES_HOME_DIR } from '../../../auth/paths';
import { parseTranscript, createOutputFilePath, writeInitialEntry, writeFinalEntry, readSubagentTranscripts } from '../output-file';

afterAll(() => {
  rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true });
});

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('parseTranscript', () => {
  it('rehydrates a subagent transcript: correlation key, mapped messages, model, tool count, timestamps', () => {
    const content = jsonl(
      {
        isSidechain: true,
        agentId: 'agent-123',
        parentToolUseId: 'toolu_parent',
        agentType: 'Explore',
        model: 'haiku',
        type: 'user',
        message: { role: 'user', content: 'find the bug' },
        timestamp: '2026-06-18T10:00:00.000Z',
      },
      {
        isSidechain: true,
        agentId: 'agent-123',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/a.ts' } }] },
        timestamp: '2026-06-18T10:00:05.000Z',
      },
      {
        isSidechain: true,
        agentId: 'agent-123',
        type: 'toolResult',
        message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'contents' }] },
        timestamp: '2026-06-18T10:00:06.000Z',
      },
      {
        isSidechain: true,
        agentId: 'agent-123',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'found it' }] },
        timestamp: '2026-06-18T10:00:10.000Z',
      },
    );

    const t = parseTranscript(content);
    expect(t).not.toBeNull();
    expect(t!.parentToolUseId).toBe('toolu_parent');
    expect(t!.agentId).toBe('agent-123');
    expect(t!.agentType).toBe('Explore');
    expect(t!.model).toBe('haiku');
    expect(t!.totalToolUseCount).toBe(1);
    expect(t!.startTimestamp).toBe(Date.parse('2026-06-18T10:00:00.000Z'));
    expect(t!.endTimestamp).toBe(Date.parse('2026-06-18T10:00:10.000Z'));

    // user prompt + two assistant messages; the toolResult folds into the tool_use block.
    expect(t!.messages).toHaveLength(3);
    expect(t!.messages[0]).toEqual({ role: 'user', contentBlocks: [{ type: 'text', text: 'find the bug' }] });
    const toolBlock = t!.messages[1]!.contentBlocks[0] as { type: string; id: string; result?: string };
    expect(toolBlock).toMatchObject({ type: 'tool_use', id: 'tc1', result: 'contents' });
  });

  it('reads the terminal-status entry (status + final result) without replaying it as a message', () => {
    const content = jsonl(
      {
        isSidechain: true,
        agentId: 'agent-123',
        parentToolUseId: 'toolu_parent',
        agentType: 'Explore',
        type: 'user',
        message: { role: 'user', content: 'find vehicle files' },
        timestamp: '2026-06-18T10:00:00.000Z',
      },
      {
        isSidechain: true,
        agentId: 'agent-123',
        type: 'status',
        status: 'stopped',
        result: ' (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)',
        timestamp: '2026-06-18T10:00:30.000Z',
      },
    );

    const t = parseTranscript(content)!;
    expect(t.status).toBe('stopped');
    expect(t.finalResult).toContain('STOPPED BY THE USER');
    // Only the user prompt is a replayable message — the status entry must not become one.
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]!.role).toBe('user');
  });

  it('returns null when the transcript cannot be correlated (no parentToolUseId)', () => {
    const content = jsonl({ agentId: 'a', type: 'user', message: { role: 'user', content: 'x' } });
    expect(parseTranscript(content)).toBeNull();
  });

  it('skips malformed lines without throwing', () => {
    const content =
      'not json\n' +
      jsonl({ agentId: 'a', parentToolUseId: 'p', type: 'user', message: { role: 'user', content: 'hi' } });
    const t = parseTranscript(content);
    expect(t).not.toBeNull();
    expect(t!.parentToolUseId).toBe('p');
  });
});

describe('readSubagentTranscripts', () => {
  it('reads a written transcript back, keyed by parent tool-call id', async () => {
    const cwd = 'C:\\GameDev\\iemis';
    const sessionId = 'session-abc';
    const path = createOutputFilePath(cwd, 'agent-xyz', sessionId);
    writeInitialEntry(path, 'agent-xyz', 'do work', cwd, { parentToolUseId: 'toolu_99', agentType: 'general-purpose', model: 'opus' });
    appendFileSync(
      path,
      JSON.stringify({ agentId: 'agent-xyz', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-06-18T10:00:01.000Z' }) + '\n',
      'utf-8',
    );

    const map = await readSubagentTranscripts(cwd, sessionId);
    expect(map.size).toBe(1);
    const t = map.get('toolu_99');
    expect(t).toBeDefined();
    expect(t!.agentId).toBe('agent-xyz');
    expect(t!.model).toBe('opus');
    expect(t!.messages.at(-1)).toEqual({ role: 'assistant', contentBlocks: [{ type: 'text', text: 'done' }] });
  });

  it('round-trips the agent template path so a restored card stays clickable', async () => {
    const cwd = 'C:\\GameDev\\iemis';
    const sessionId = 'session-template';
    const templatePath = 'C:\\Users\\me\\.claude\\agents\\engineering\\engineering-code-reviewer.md';
    const path = createOutputFilePath(cwd, 'agent-tmpl', sessionId);
    writeInitialEntry(path, 'agent-tmpl', 'review', cwd, {
      parentToolUseId: 'toolu_tmpl',
      agentType: 'Code Reviewer',
      model: 'GPT-5.4',
      templatePath,
    });

    const t = (await readSubagentTranscripts(cwd, sessionId)).get('toolu_tmpl');
    expect(t).toBeDefined();
    expect(t!.templatePath).toBe(templatePath);
  });

  it('round-trips a written terminal status so a resumed card shows the real outcome', async () => {
    const cwd = 'C:\\GameDev\\iemis';
    const sessionId = 'session-stopped';
    const path = createOutputFilePath(cwd, 'agent-stop', sessionId);
    writeInitialEntry(path, 'agent-stop', 'search', cwd, { parentToolUseId: 'toolu_stop', agentType: 'Explore', model: 'haiku' });
    writeFinalEntry(path, 'agent-stop', 'stopped', ' (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)');

    const t = (await readSubagentTranscripts(cwd, sessionId)).get('toolu_stop')!;
    expect(t.status).toBe('stopped');
    expect(t.finalResult).toContain('STOPPED BY THE USER');
  });

  it('returns an empty map when no transcripts exist for the session', async () => {
    const map = await readSubagentTranscripts('C:\\GameDev\\nope', 'missing-session');
    expect(map.size).toBe(0);
  });
});
