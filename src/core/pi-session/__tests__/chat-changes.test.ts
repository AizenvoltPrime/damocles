import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  changeTotals,
  collectRecords,
  composeReviewMessage,
  diffLine,
  isCommentable,
  lineAnchor,
  MAX_PATCH_BYTES,
  projectChatChanges,
  turnsOnBranch,
  unifiedDiff,
  worktreeChanges,
  type ChatChangesIo,
  type DiskRead,
  type FileText,
  type HandOff,
  type WorktreeGit,
} from '../chat-changes';
import { checkpointCommitOf } from '../chat-review';
import { filePatch } from '../tools/file-patch';
import { MAX_DIFF_BYTES } from '../../scm/repository';
import type { PersistedAgentMessage } from '../agent-records';

/** D60's file set and baselines (docs/invariants.md "Chat review"), over hand-built branches and file systems. */

const ROOT = path.resolve('/work/project');
const at = (relative: string, root = ROOT): string => path.join(root, ...relative.split('/'));

let nextId = 0;
const entry = (message: Record<string, unknown>): SessionEntry => ({ type: 'message', id: `e${++nextId}`, parentId: null, timestamp: new Date(0).toISOString(), message } as unknown as SessionEntry);
const user = (id: string, text = 'do it'): SessionEntry => ({ ...entry({ role: 'user', content: text }), id });
const call = (id: string, name: string, args: Record<string, unknown>): Record<string, unknown> => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const result = (id: string, toolName: string, details: unknown, isError = false): Record<string, unknown> => ({ role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text: 'ok' }], details, isError });
const patchOf = (file: string, before: string, after: string): string => {
  const made = filePatch(file, before, after);
  if (!('patch' in made)) throw new Error('no patch');
  return made.patch;
};

// An Edit result of the chat: the call and its result.
function edit(callId: string, file: string, before: string, after: string): SessionEntry[] {
  return [entry(call(callId, 'Edit', { file_path: file })), entry(result(callId, 'Edit', { patch: patchOf(file, before, after) }))];
}

function writeNew(callId: string, file: string, content: string): SessionEntry[] {
  return [entry(call(callId, 'write', { path: file, content })), entry(result(callId, 'write', { created: true }))];
}

// A file system, checkpoints by turn and side, and the disk.
function fakeIo(files: { disk: Record<string, string | DiskRead>; checkpoints?: Record<string, Record<string, FileText>> }): ChatChangesIo & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    checkpoint: async (turn, relativePath, side) => {
      asked.push(`${turn}:${side}:${relativePath}`);
      return files.checkpoints?.[`${turn}:${side}`]?.[relativePath] ?? { kind: 'unavailable' };
    },
    disk: async (absolute) => {
      const text = files.disk[absolute];
      if (typeof text === 'object') return text;
      // a binary file's digest is its content here
      return text === undefined ? { kind: 'absent' } : text.includes('\0') ? { kind: 'binary', digest: text } : { kind: 'text', text };
    },
  };
}

const text = (value: string): FileText => ({ kind: 'text', text: value });
const records = (branch: readonly SessionEntry[], agentMessages = new Map<string, readonly PersistedAgentMessage[]>(), handOffs: readonly HandOff[] = []) =>
  collectRecords({ branch, folder: ROOT, handOffs, agentMessages });

describe('the project-folder file set', () => {
  it('lists the files the chat\'s and its subagent\'s records changed, and nothing a shell command or another chat made', async () => {
    const subagentWork: PersistedAgentMessage[] = [
      call('s1', 'Edit', { file_path: at('src/c.ts') }) as PersistedAgentMessage,
      result('s1', 'Edit', { patch: patchOf(at('src/c.ts'), 'c\n', 'C\n') }) as PersistedAgentMessage,
    ];
    const branch = [
      user('t1'),
      ...edit('e1', at('src/a.ts'), 'a\nb\n', 'A\nb\n'),
      ...writeNew('w1', 'src/b.ts', 'new\nfile\n'),
      entry(call('agent1', 'Agent', { prompt: 'fix c' })),
      entry(result('agent1', 'Agent', { agentId: 'x', status: 'completed' })),
      entry(call('sh1', 'Bash', { command: 'echo x > shell.txt' })),
      entry(result('sh1', 'Bash', {})),
      entry(call('bad', 'Edit', { file_path: at('src/failed.ts') })),
      entry(result('bad', 'Edit', {}, true)),
    ];
    const io = fakeIo({
      disk: { [at('src/a.ts')]: 'A\nb\n', [at('src/b.ts')]: 'new\nfile\n', [at('src/c.ts')]: 'C\n', [at('shell.txt')]: 'x\n', [at('other-chat.ts')]: 'theirs\n' },
      checkpoints: { 't1:before': { 'src/a.ts': text('a\nb\n'), 'src/b.ts': { kind: 'absent' }, 'src/c.ts': text('c\n') } },
    });
    const files = await projectChatChanges(records(branch, new Map([['agent1', subagentWork]])), 'chat', 't1', ROOT, io);
    expect(files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['src/a.ts', 'M', 1, 1],
      ['src/b.ts', 'A', 2, 0],
      ['src/c.ts', 'M', 1, 1],
    ]);
    expect(changeTotals(files)).toEqual({ added: 4, removed: 2, files: 3 });
  });

  it('lists a team\'s member records under the team\'s call', async () => {
    const memberWork: PersistedAgentMessage[] = [
      call('m1', 'write', { path: at('team.md'), content: 'plan\n' }) as PersistedAgentMessage,
      result('m1', 'write', { created: true }) as PersistedAgentMessage,
    ];
    const branch = [user('t1'), entry(call('team1', 'create_team', {})), entry(result('team1', 'create_team', {}))];
    const io = fakeIo({ disk: { [at('team.md')]: 'plan\n' }, checkpoints: { 't1:before': { 'team.md': { kind: 'absent' } } } });
    const files = await projectChatChanges(records(branch, new Map([['team1', memberWork]])), 'chat', 't1', ROOT, io);
    expect(files.map((file) => [file.path, file.status])).toEqual([['team.md', 'A']]);
  });

  it('lists a generated image with no line diff', async () => {
    const branch = [user('t1'), entry(call('g1', 'GenerateImage', { file_path: 'art/cat.png' })), entry(result('g1', 'GenerateImage', { filePath: at('art/cat.png'), mimeType: 'image/png' }))];
    const io = fakeIo({ disk: { [at('art/cat.png')]: 'PNG\0data' } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ path: 'art/cat.png', status: 'A', binary: true, added: 0, removed: 0 });
    expect(unifiedDiff(file!)).toEqual({ kind: 'binary' });
  });
});

describe('baselines', () => {
  const branch = [user('t1'), ...edit('e1', at('a.txt'), 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')];

  it('reads the checkpoint before the turn that first changed the file', async () => {
    const io = fakeIo({ disk: { [at('a.txt')]: 'one\r\nTWO\r\nthree\r\n' }, checkpoints: { 't1:before': { 'a.txt': text('one\r\ntwo\r\nthree\r\n') } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ status: 'M', added: 1, removed: 1, outsideEdits: false });
    expect(io.asked).toContain('t1:before:a.txt');
  });

  it('rebuilds it from the recorded patches when no checkpoint holds it (a home-folder chat, a turn that is not rewindable, retention)', async () => {
    const io = fakeIo({ disk: { [at('a.txt')]: 'one\nTWO\nthree\n' } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ status: 'M', added: 1, removed: 1 });
    expect(file!.diff).toEqual({ kind: 'texts', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' });
  });

  it('rebuilds it from the patches when the checkpoint skipped a file the chat edited', async () => {
    const io = fakeIo({ disk: { [at('a.txt')]: 'one\nTWO\nthree\n' }, checkpoints: { 't1:before': { 'a.txt': { kind: 'absent' } } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ status: 'M' });
    expect(file!.diff).toMatchObject({ before: 'one\ntwo\nthree\n' });
  });

  it('rebuilds it from the patches for a file outside the working folder, which keeps its absolute path', async () => {
    const outside = path.resolve('/elsewhere/notes.txt');
    const io = fakeIo({ disk: { [outside]: 'x\nY\n' } });
    const [file] = await projectChatChanges(records([user('t1'), ...edit('e1', outside, 'x\ny\n', 'x\nY\n')]), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ path: outside, status: 'M' });
    expect(io.asked).toEqual([]);
  });

  it('shows the recorded patches, marked, when the file moved on so they no longer undo', async () => {
    const io = fakeIo({ disk: { [at('a.txt')]: 'rewritten\nentirely\n' } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ outsideEdits: true, added: 1, removed: 1 });
    expect(file!.diff.kind).toBe('patches');
  });

  it('takes a running turn\'s baseline from the producer\'s in-memory before-commit, and a persisted turn\'s from its entry', () => {
    const pending = { userEntryId: 't2', beforeCommit: 'b'.repeat(40), folderId: '0123456789abcdef' };
    const v3 = { v: 3, kind: 'checkpoint', turnId: 'turn-1', userEntryId: 't1', beforeCommit: 'c'.repeat(40), afterCommit: 'd'.repeat(40), prompt: '', fileCount: 0, fileChanges: [], createdAt: '', repo: 'folder', folderId: '0123456789abcdef', skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null } };
    const withEntry: SessionEntry[] = [user('t1'), { type: 'custom', id: 'cp', parentId: null, timestamp: '', customType: 'damocles-checkpoint', data: v3 } as unknown as SessionEntry, user('t2')];
    expect(checkpointCommitOf(withEntry, 'session.jsonl', 't1', 'before', pending)?.commit).toBe('c'.repeat(40));
    expect(checkpointCommitOf(withEntry, 'session.jsonl', 't1', 'after', pending)?.commit).toBe('d'.repeat(40));
    expect(checkpointCommitOf(withEntry, 'session.jsonl', 't2', 'before', pending)?.commit).toBe('b'.repeat(40));
    expect(checkpointCommitOf(withEntry, 'session.jsonl', 't2', 'after', pending)).toBeUndefined();
    expect(checkpointCommitOf(withEntry, 'session.jsonl', 't3', 'before', pending)).toBeUndefined();
  });
});

describe('a file\'s state against the chat', () => {
  it('marks a file the user edited after the chat', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'a\nb\n', 'A\nb\n')];
    const io = fakeIo({ disk: { [at('a.txt')]: 'A\nb\nmine\n' }, checkpoints: { 't1:before': { 'a.txt': text('a\nb\n') } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ outsideEdits: true, added: 2, removed: 1 });
  });

  it('falls back to the turn\'s after-state for the chat\'s last result when its patches do not apply', async () => {
    const branch = [user('t1'), entry(call('w1', 'write', { path: 'a.txt', content: 'x' })), entry(result('w1', 'write', { patchOmitted: 'tooLarge' }))];
    const io = fakeIo({ disk: { [at('a.txt')]: 'after\n' }, checkpoints: { 't1:before': { 'a.txt': text('before\n') }, 't1:after': { 'a.txt': text('after\n') } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ outsideEdits: false, status: 'M' });
    expect(io.asked).toContain('t1:after:a.txt');
  });

  it('drops a file reverted by hand to its baseline when only the recorded patches know that baseline', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'one\ntwo\n', 'one\nTWO\n')];
    const io = fakeIo({ disk: { [at('a.txt')]: 'one\ntwo\n' } });
    expect(await projectChatChanges(records(branch), 'chat', 't1', ROOT, io)).toEqual([]);
  });

  it('drops a file reverted by hand to its baseline', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'a\n', 'A\n')];
    const io = fakeIo({ disk: { [at('a.txt')]: 'a\n' }, checkpoints: { 't1:before': { 'a.txt': text('a\n') } } });
    expect(await projectChatChanges(records(branch), 'chat', 't1', ROOT, io)).toEqual([]);
  });
});

describe('scopes, forks and hand-offs', () => {
  it('shows only the latest turn\'s files against the checkpoint before it', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'a\n', 'A\n'), user('t2'), ...edit('e2', at('a.txt'), 'A\n', 'AA\n'), ...edit('e3', at('b.txt'), 'b\n', 'B\n')];
    const io = fakeIo({
      disk: { [at('a.txt')]: 'AA\n', [at('b.txt')]: 'B\n' },
      checkpoints: { 't1:before': { 'a.txt': text('a\n') }, 't2:before': { 'a.txt': text('A\n'), 'b.txt': text('b\n') } },
    });
    expect(turnsOnBranch(branch)).toEqual(['t1', 't2']);
    const turn = await projectChatChanges(records(branch), 'turn', 't2', ROOT, io);
    expect(turn.map((file) => [file.path, (file.diff as { before: string }).before])).toEqual([['a.txt', 'A\n'], ['b.txt', 'b\n']]);
    const none = await projectChatChanges(records(branch), 'turn', 't3', ROOT, io);
    expect(none).toEqual([]);
  });

  it('lists the turns a fork inherited, from their own checkpoints', async () => {
    // a fork's branch starts with the entries it inherited, then its own turns
    const inherited = [user('parent-turn'), ...edit('e1', at('a.txt'), 'a\n', 'A\n')];
    const branch = [...inherited, user('fork-turn'), ...edit('e2', at('b.txt'), 'b\n', 'B\n')];
    const io = fakeIo({ disk: { [at('a.txt')]: 'A\n', [at('b.txt')]: 'B\n' }, checkpoints: { 'parent-turn:before': { 'a.txt': text('a\n') }, 'fork-turn:before': { 'b.txt': text('b\n') } } });
    const files = await projectChatChanges(records(branch), 'chat', 'fork-turn', ROOT, io);
    expect(files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('matches records by the path relative to the folder they were made in, and reads now from the current folder', async () => {
    const worktree = path.resolve('/work/worktrees/project/chat');
    const branch = [user('t1'), ...edit('e1', at('src/x.ts'), 'x\n', 'X\n'), user('t2'), ...edit('e2', at('src/x.ts', worktree), 'X\n', 'XX\n')];
    const handOffs: HandOff[] = [{ entryId: 't2', folder: worktree }];
    const io = fakeIo({ disk: { [at('src/x.ts', worktree)]: 'XX\n' }, checkpoints: { 't1:before': { 'src/x.ts': text('x\n') } } });
    const [file] = await projectChatChanges(records(branch, undefined, handOffs), 'chat', 't2', worktree, io);
    expect(file).toMatchObject({ path: 'src/x.ts', absolute: at('src/x.ts', worktree), outsideEdits: false });
    expect(file!.diff).toMatchObject({ before: 'x\n', after: 'XX\n' });
  });
});

describe('the worktree rule', () => {
  it('lists every change against the base commit, committed or not, a shell command\'s untracked file included', async () => {
    const worktree = path.resolve('/work/worktrees/project/chat');
    const git: WorktreeGit = {
      changedSinceBase: async () => [{ status: 'M', path: 'src/a.ts' }, { status: 'D', path: 'gone.txt' }],
      untracked: async () => ['made-by-shell.txt'],
      atBase: async (_base, relative) => (relative === 'src/a.ts' ? text('a\n') : relative === 'gone.txt' ? text('bye\n') : { kind: 'absent' }),
    };
    const disk = fakeIo({ disk: { [at('src/a.ts', worktree)]: 'A\n', [at('made-by-shell.txt', worktree)]: 'shell\n' } }).disk;
    const files = await worktreeChanges(worktree, 'f'.repeat(40), git, disk);
    expect(files.map((file) => [file.path, file.status, file.added, file.removed, file.outsideEdits])).toEqual([
      ['gone.txt', 'D', 0, 1, false],
      ['made-by-shell.txt', 'A', 1, 0, false],
      ['src/a.ts', 'M', 1, 1, false],
    ]);
  });
});

describe('the review message', () => {
  it('lists each comment as path:line, the quoted line fenced as data from core\'s own diff, and the text', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'keep\nold `x`\n', 'keep\nnew ```y```\n')];
    const io = fakeIo({ disk: { [at('a.txt')]: 'keep\nnew ```y```\n' }, checkpoints: { 't1:before': { 'a.txt': text('keep\nold `x`\n') } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(diffLine(file!, 'added', 2)).toBe('new ```y```');
    expect(diffLine(file!, 'removed', 2)).toBe('old `x`');
    expect(diffLine(file!, 'context', 9)).toBeUndefined();
    const message = composeReviewMessage([
      { path: 'a.txt', line: 2, removed: false, quoted: 'new ```y```', text: 'Why triple backticks?' },
      { path: 'a.txt', line: 2, removed: true, quoted: 'old `x`', text: ' Keep this one. ' },
    ]);
    expect(message).toBe(['a.txt:2', '````text', 'new ```y```', '````', 'Why triple backticks?', '', 'a.txt:2 (removed)', '```text', 'old `x`', '```', 'Keep this one.'].join('\n'));
    const patch = unifiedDiff(file!);
    expect(patch.kind === 'patch' && patch.patch.startsWith('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n')).toBe(true);
  });

  it('anchors a comment to its line and the lines beside it, and only while a hunk shows the line', async () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = before.map((line, index) => (index === 9 ? 'line 10 changed' : line));
    const branch = [user('t1'), ...edit('e1', at('a.txt'), `${before.join('\n')}\n`, `${after.join('\n')}\n`)];
    const io = fakeIo({ disk: { [at('a.txt')]: `${after.join('\n')}\n` }, checkpoints: { 't1:before': { 'a.txt': text(`${before.join('\n')}\n`) } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(lineAnchor(file!, 'added', 10)).toBe('line 9\nline 10 changed\nline 11');
    expect(lineAnchor(file!, 'context', 12)).toBe('line 11\nline 12\nline 13');
    // line 2 is outside every hunk of three context lines
    expect(diffLine(file!, 'context', 2)).toBeUndefined();
    expect(lineAnchor(file!, 'context', 2)).toBeUndefined();
  });
});

describe('record order', () => {
  it('keeps a parent\'s Write of a new file ahead of a subagent\'s Edit of it in the same turn: the row is added, with no outside-edit mark', async () => {
    const subagentWork: PersistedAgentMessage[] = [
      call('s1', 'Edit', { file_path: at('new.ts') }) as PersistedAgentMessage,
      result('s1', 'Edit', { patch: patchOf(at('new.ts'), 'one\n', 'one\ntwo\n') }) as PersistedAgentMessage,
    ];
    const branch = [
      user('t1'),
      ...writeNew('w1', 'new.ts', 'one\n'),
      entry(call('agent1', 'Agent', { prompt: 'extend it' })),
      entry(result('agent1', 'Agent', { agentId: 'x', status: 'completed' })),
    ];
    const ordered = records(branch, new Map([['agent1', subagentWork]]));
    expect(ordered.map((record) => (record.created ? 'created' : 'edited'))).toEqual(['created', 'edited']);
    // a checkpointed chat, whose checkpoint lacks the new file, and a chat with no checkpoint
    for (const checkpoints of [{ 't1:before': { 'new.ts': { kind: 'absent' } as FileText } }, undefined]) {
      const [file] = await projectChatChanges(ordered, 'chat', 't1', ROOT, fakeIo({ disk: { [at('new.ts')]: 'one\ntwo\n' }, ...(checkpoints ? { checkpoints } : {}) }));
      expect(file).toMatchObject({ status: 'A', added: 2, removed: 0, outsideEdits: false });
      expect(file!.diff).toEqual({ kind: 'texts', before: '', after: 'one\ntwo\n' });
    }
  });
});

describe('paths, bounds and unreadable files', () => {
  it('resolves pi\'s write path as pi does: a leading @ is dropped and ~ is the home folder', () => {
    const branch = [user('t1'), ...writeNew('w1', '@src/a.ts', 'x\n'), ...writeNew('w2', '~/notes.md', 'y\n')];
    expect(records(branch).map((record) => record.file)).toEqual([at('src/a.ts'), path.join(os.homedir(), 'notes.md')]);
  });

  it('reads no checkpoint for a file past the size bound, and lists it with no diff', async () => {
    const branch = [user('t1'), ...edit('e1', at('big.txt'), 'a\n', 'b\n')];
    const io = fakeIo({ disk: { [at('big.txt')]: { kind: 'tooLarge' } }, checkpoints: { 't1:before': { 'big.txt': text('a\n') } } });
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(file).toMatchObject({ status: 'M', diff: { kind: 'tooLarge' } });
    expect(io.asked).toEqual([]);
  });

  it('lists a file that could not be read with no diff, and still lists the others', async () => {
    const branch = [user('t1'), ...edit('e1', at('locked.txt'), 'a\n', 'b\n'), ...edit('e2', at('free.txt'), 'a\n', 'b\n')];
    const io = fakeIo({ disk: { [at('locked.txt')]: { kind: 'unreadable' }, [at('free.txt')]: 'b\n' } });
    const files = await projectChatChanges(records(branch), 'chat', 't1', ROOT, io);
    expect(files.map((file) => [file.path, file.diff.kind])).toEqual([['free.txt', 'texts'], ['locked.txt', 'unreadable']]);
    expect(unifiedDiff(files[1]!)).toEqual({ kind: 'unreadable' });
  });

  it('drops a binary file whose bytes are back at its baseline, and keeps one that differs', async () => {
    const branch = [user('t1'), entry(call('w1', 'write', { path: 'img.bin', content: 'x' })), entry(result('w1', 'write', { patchOmitted: 'binary' }))];
    const baseline = { 't1:before': { 'img.bin': { kind: 'binary', digest: 'old\0' } as FileText } };
    expect(await projectChatChanges(records(branch), 'chat', 't1', ROOT, fakeIo({ disk: { [at('img.bin')]: 'old\0' }, checkpoints: baseline }))).toEqual([]);
    const [changed] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, fakeIo({ disk: { [at('img.bin')]: 'new\0' }, checkpoints: baseline }));
    expect(changed).toMatchObject({ status: 'M', binary: true });
  });

  it('sends a diff past the source control bound as too large', async () => {
    expect(MAX_PATCH_BYTES).toBe(MAX_DIFF_BYTES);
    const long = 'x'.repeat(MAX_PATCH_BYTES);
    const branch = [user('t1'), ...writeNew('w1', 'min.js', `${long}\n`)];
    const [file] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, fakeIo({ disk: { [at('min.js')]: `${long}\n` } }));
    expect(file!.diff.kind).toBe('texts');
    expect(unifiedDiff(file!)).toEqual({ kind: 'tooLarge' });
  });

  it('prints an empty side of a hunk as git does, so a new file reads @@ -0,0 and a re-printed recorded hunk keeps its numbers', async () => {
    const created = [user('t1'), ...writeNew('w1', 'new.txt', 'x\ny\n')];
    const [file] = await projectChatChanges(records(created), 'chat', 't1', ROOT, fakeIo({ disk: { [at('new.txt')]: 'x\ny\n' } }));
    const printed = unifiedDiff(file!);
    expect(printed.kind === 'patch' && printed.patch).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n');
    // an insertion after line 2 whose patches no longer undo shows the recorded hunk with its own numbers
    const inserted = [user('t1'), ...edit('e1', at('a.txt'), 'one\ntwo\n', 'one\ntwo\nthree\n')];
    const [patches] = await projectChatChanges(records(inserted), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'rewritten\n' } }));
    const recorded = unifiedDiff(patches!);
    expect(recorded.kind === 'patch' && recorded.patch.split('\n')[2]).toBe(patchOf(at('a.txt'), 'one\ntwo\n', 'one\ntwo\nthree\n').split('\n').find((line) => line.startsWith('@@')));
  });
});

describe('what the tab offers and reloads', () => {
  it('takes no comments on a diff of the recorded patches, and on two texts it does', async () => {
    const branch = [user('t1'), ...edit('e1', at('a.txt'), 'one\ntwo\n', 'one\nTWO\n')];
    const [patches] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'rewritten\n' } }));
    expect(patches!.diff.kind).toBe('patches');
    expect(isCommentable(patches!)).toBe(false);
    expect(diffLine(patches!, 'added', 2)).toBeUndefined();
    const [texts] = await projectChatChanges(records(branch), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'one\nTWO\n' } }));
    expect(isCommentable(texts!)).toBe(true);
  });

  it('gives a file a new revision when its content moves and its counts stay', async () => {
    const first = [user('t1'), ...edit('e1', at('a.txt'), 'a\n', 'b\n')];
    const second = [...first, ...edit('e2', at('a.txt'), 'b\n', 'c\n')];
    const checkpoints = { 't1:before': { 'a.txt': text('a\n') } };
    const [atB] = await projectChatChanges(records(first), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'b\n' }, checkpoints }));
    const [atC] = await projectChatChanges(records(second), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'c\n' }, checkpoints }));
    expect([atB!.added, atB!.removed]).toEqual([atC!.added, atC!.removed]);
    expect(atB!.revision).not.toBe(atC!.revision);
    const [again] = await projectChatChanges(records(second), 'chat', 't1', ROOT, fakeIo({ disk: { [at('a.txt')]: 'c\n' }, checkpoints }));
    expect(again!.revision).toBe(atC!.revision);
  });
});
