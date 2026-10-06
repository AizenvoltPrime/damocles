import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { parsePatch } from 'diff';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { installLogSink } from '../../logger';
import { filePatch } from '../tools/file-patch';
import { pendingPromptDescriber, promptOwnerOf, PROMPT_SUMMARY_MAX_CHARS, type PromptOwners } from '../pending-prompts';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PromptOwner } from '../../../shared/types/permissions';
import type { PendingKind, RaisedPrompt } from '../session-state';

vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, parsePatch: vi.fn(actual.parsePatch) };
});

const CWD = path.resolve('/work/project');
const MAIN: PromptOwner = { kind: 'main' };

function summaryOf(request: ExtensionToWebviewMessage, kind: PendingKind = 'approval'): string | undefined {
  return pendingPromptDescriber(CWD)([{ id: 'p1', kind, request }])[0]!.summary;
}

const permission = (fields: Partial<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>>): ExtensionToWebviewMessage => ({
  type: 'requestPermission',
  toolUseId: 'p1',
  toolName: 'Edit',
  toolInput: {},
  owner: MAIN,
  ...fields,
});

beforeAll(() => {
  installFakePlatform();
});

describe('pending prompt summaries', () => {
  it('names an edit by its path inside the chat folder and the lines its patch changes', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nB\nc\nd\ne\n';
    const { patch } = filePatch('src/a.ts', before, after) as { patch: string };
    expect(summaryOf(permission({ filePath: path.join(CWD, 'src', 'a.ts'), patch }))).toBe(`edit ${path.join('src', 'a.ts')} (+3 −1)`);
    expect(summaryOf(permission({ filePath: 'src/a.ts', patchOmitted: 'tooLarge' }))).toBe(`edit ${path.join('src', 'a.ts')}`);
  });

  it('names a new file by the lines it creates, and a file outside the chat folder by its absolute path', () => {
    const outside = path.resolve('/elsewhere/notes.md');
    expect(summaryOf(permission({ toolName: 'Write', filePath: outside, toolInput: { content: 'one\ntwo\n' } }))).toBe(`create ${outside} (+2)`);
  });

  it('names a shell command by its first line, an image by its path, a skill and any other tool by name', () => {
    expect(summaryOf(permission({ toolName: 'Bash', command: '  npm test  \nnpm run lint' }))).toBe('run `npm test`');
    expect(summaryOf(permission({ toolName: 'GenerateImage', filePath: 'art/logo.png' }))).toBe(`generate image ${path.join('art', 'logo.png')}`);
    expect(summaryOf(permission({ toolName: 'mcp__github__get_issue' }))).toBe('use mcp__github__get_issue');
    expect(summaryOf({ type: 'requestSkillApproval', toolUseId: 'p1', skillName: 'review-pr', owner: MAIN })).toBe('use skill review-pr');
  });

  it('skips the blank lines before a command, and names nothing for a blank command or a file tool with no path', () => {
    expect(summaryOf(permission({ toolName: 'Bash', command: '\n   \r\n  npm test\nnpm run lint' }))).toBe('run `npm test`');
    expect(summaryOf(permission({ toolName: 'Bash', command: ' \n\t\n' }))).toBeUndefined();
    expect(summaryOf(permission({ toolName: 'Edit', patchOmitted: 'tooLarge' }))).toBeUndefined();
    expect(summaryOf(permission({ toolName: 'Write', toolInput: { content: 'one\n' } }))).toBeUndefined();
    expect(summaryOf(permission({ toolName: 'GenerateImage', filePath: '  ' }))).toBeUndefined();
  });

  it('names a question by its first question, an input by its title or message, and a plan by nothing', () => {
    const question = { question: 'Where should the counters live?', header: 'Store', multiSelect: false, options: [] };
    expect(summaryOf({ type: 'requestQuestion', toolUseId: 'p1', questions: [question, { ...question, question: 'Second?' }], owner: MAIN }, 'question')).toBe('Where should the counters live?');
    expect(summaryOf({ type: 'requestForm', toolUseId: 'p1', form: { title: 'Log in', fields: [] }, owner: MAIN }, 'input')).toBe('Log in');
    expect(summaryOf({ type: 'requestForm', toolUseId: 'p1', form: { fields: [] }, owner: MAIN }, 'input')).toBeUndefined();
    expect(summaryOf({ type: 'requestElicitation', elicitationId: 'e1', serverName: 'github', message: 'Pick a repository', mode: 'form' }, 'input')).toBe('Pick a repository');
    expect(summaryOf({ type: 'extensionUiRequest', requestId: 'r1', kind: 'input', title: 'API token' }, 'input')).toBe('API token');
    expect(summaryOf({ type: 'requestPlanApproval', toolUseId: 'p1', planContent: '1. Do it', owner: MAIN }, 'plan')).toBeUndefined();
  });

  it('flattens model text to one line without bidi overrides and caps it at 160 characters', () => {
    const question = { header: 'Q', multiSelect: false, options: [] };
    expect(summaryOf({ type: 'requestQuestion', toolUseId: 'p1', questions: [{ ...question, question: 'Line one\nline\u202e two\t ok' }], owner: MAIN }, 'question')).toBe('Line one line two ok');
    const long = summaryOf({ type: 'requestQuestion', toolUseId: 'p1', questions: [{ ...question, question: '😀'.repeat(200) }], owner: MAIN }, 'question')!;
    expect([...long]).toHaveLength(PROMPT_SUMMARY_MAX_CHARS);
    expect(long.endsWith('😀…')).toBe(true);
  });
});

describe('the pending prompt describer', () => {
  const edit = (id: string): RaisedPrompt => {
    const { patch } = filePatch('src/a.ts', 'a\nb\n', 'a\nB\n') as { patch: string };
    return { id, kind: 'approval', request: permission({ toolUseId: id, filePath: 'src/a.ts', patch }) };
  };
  const question: RaisedPrompt = {
    id: 'q1',
    kind: 'question',
    request: { type: 'requestQuestion', toolUseId: 'q1', questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [] }], owner: MAIN },
  };

  beforeEach(() => {
    vi.mocked(parsePatch).mockClear();
  });

  it('summarizes a prompt once while it stays raised, and again once it was removed and raised anew', () => {
    const describePrompts = pendingPromptDescriber(CWD);
    const first = edit('t1');
    describePrompts([first]);
    describePrompts([first]);
    expect(parsePatch).toHaveBeenCalledTimes(1);
    expect(describePrompts([first, edit('t2')]).map((prompt) => prompt.summary)).toEqual([`edit ${path.join('src', 'a.ts')} (+1 −1)`, `edit ${path.join('src', 'a.ts')} (+1 −1)`]);
    expect(parsePatch).toHaveBeenCalledTimes(2);

    describePrompts([]);
    describePrompts([first]);
    expect(parsePatch).toHaveBeenCalledTimes(3);
  });

  it('gives a prompt whose summary throws none, logs no prompt text, and still describes the others', () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => void lines.push(line), show: () => undefined, dispose: () => undefined });
    const broken: RaisedPrompt = {
      id: 't1',
      kind: 'approval',
      request: permission({ toolUseId: 't1', filePath: 'src/secret.ts', patch: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n?secret line\n' }),
    };

    expect(pendingPromptDescriber(CWD)([broken, question])).toEqual([
      { id: 't1', kind: 'approval', owner: { kind: 'main' } },
      { id: 'q1', kind: 'question', owner: { kind: 'main' }, summary: 'Which store?' },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('t1');
    expect(lines[0]).not.toContain('secret');
  });

  it('reports the owner the prompt states, not one it would resolve from the parent tool use id now', () => {
    const team: PromptOwner = { kind: 'team', teamId: 'team-1', agentId: 'agent-7', teamTitle: 'Lockout', agentName: 'Mira' };
    const raised: RaisedPrompt = { id: 't1', kind: 'approval', request: permission({ toolUseId: 't1', owner: team, parentToolUseId: 'agent-7' }) };
    expect(pendingPromptDescriber(CWD)([raised])[0]!.owner).toEqual(team);
  });
});

describe('the prompt owner resolver', () => {
  const owners: PromptOwners = {
    teamMember: (id) => (id === 'agent-7' ? { teamId: 'team-1', teamTitle: 'Lock\nout\u202e', agentName: 'Mira\u202e' } : null),
    subagentOfToolCall: (id) => (id === 'call-agent' ? 'sub-1' : undefined),
  };

  it('names the chat, a subagent by its record id, or a team member with its team, both names on one line', () => {
    expect(promptOwnerOf(null, owners)).toEqual({ kind: 'main' });
    expect(promptOwnerOf('call-agent', owners)).toEqual({ kind: 'subagent', agentId: 'sub-1' });
    expect(promptOwnerOf('agent-7', owners)).toEqual({ kind: 'team', teamId: 'team-1', agentId: 'agent-7', teamTitle: 'Lock out', agentName: 'Mira' });
    expect(promptOwnerOf('call-finished', owners)).toEqual({ kind: 'main' });
  });
});
