import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreeFolderFor } from '../../../core/worktrees/records';
import { localRecord, remoteChatRecord, WorktreeRecords } from '../worktrees/records';

const ROOT = path.resolve('/home/u/.damocles/worktrees');
const PROJECT = path.resolve('/work/alpha');

function chatRecord(id: string, worktreeRoot: string): Record<string, unknown> {
  return { id, kind: 'chat', projectPath: PROJECT, repositoryRoot: PROJECT, worktreeRoot, workingFolder: worktreeRoot, branch: 'damocles/fix', index: 1, baseCommit: 'a'.repeat(40), createdAt: 1 };
}

describe('core\'s worktree records as main reads them', () => {
  it('keeps a chat record at the folder the registry rule names, so trust follows it to its project', () => {
    const lines: string[] = [];
    const records = new WorktreeRecords(localRecord(ROOT), (line) => lines.push(line));
    let changes = 0;
    records.onDidChange(() => changes++);
    const root = worktreeFolderFor(ROOT, PROJECT, 'abcd1234');
    records.apply([chatRecord('abcd1234', root)]);
    expect(records.liveChatRecordAt(root)?.projectPath).toBe(PROJECT);
    expect(records.liveChatRecords(PROJECT).map((record) => record.id)).toEqual(['abcd1234']);
    expect(changes).toBe(1);
    records.apply([chatRecord('abcd1234', root)]);
    expect(changes).toBe(1);
    expect(lines).toEqual([]);
  });

  it('drops a record that would map any other folder onto a project, and logs it', () => {
    const lines: string[] = [];
    const records = new WorktreeRecords(localRecord(ROOT), (line) => lines.push(line));
    const elsewhere = path.resolve('/other-repo');
    records.apply([chatRecord('abcd1234', elsewhere), { id: 'x', kind: 'nonsense' }]);
    expect(records.records()).toEqual([]);
    expect(records.liveChatRecordAt(elsewhere)).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/dropped a worktree record core published/);
  });
});

describe('a remote core\'s worktree records as main reads them', () => {
  // the registry folder on the target, which main knows only from each record's own worktree
  const TARGET_ROOT = path.resolve('/srv/home/.damocles/worktrees');
  const remoteRecord = (id: string, projectPath = PROJECT): Record<string, unknown> => ({ ...chatRecord(id, worktreeFolderFor(TARGET_ROOT, projectPath, id)), projectPath, repositoryRoot: projectPath });

  it('keeps a live chat record of one of the host\'s open projects', () => {
    const lines: string[] = [];
    const records = new WorktreeRecords(remoteChatRecord(() => [PROJECT], () => process.platform), (line) => lines.push(line));
    records.apply([remoteRecord('abcd1234')]);
    expect(records.liveChatRecords(PROJECT).map((record) => record.id)).toEqual(['abcd1234']);
    expect(lines).toEqual([]);
  });

  it('drops an adopted record, a chat of a project the host does not list, and one whose worktree is not where the registry rule puts it', () => {
    const lines: string[] = [];
    const records = new WorktreeRecords(remoteChatRecord(() => [PROJECT], () => process.platform), (line) => lines.push(line));
    const misplaced = path.resolve('/srv/elsewhere/x/abcd1236');
    records.apply([
      { ...remoteRecord('abcd1234'), kind: 'adopted' },
      remoteRecord('abcd1235', path.resolve('/srv/other')),
      { ...remoteRecord('abcd1236'), worktreeRoot: misplaced, workingFolder: misplaced },
      { ...remoteRecord('abcd1237'), worktreeRoot: 'relative/abcd1237', workingFolder: 'relative/abcd1237' },
    ]);
    expect(records.records()).toEqual([]);
    expect(lines).toHaveLength(4);
  });
});

describe('a remote core\'s worktree records on a target of another OS', () => {
  // Each target's registry places worktrees by its own path rules; the client's OS must not matter.
  const TARGETS = [
    { os: 'linux', root: '/home/u/.damocles/worktrees', project: '/srv/App', other: '/srv/app' },
    { os: 'win32', root: 'C:\\Users\\u\\.damocles\\worktrees', project: 'C:\\Work\\App', other: 'c:\\work\\app' },
  ] as const;

  for (const target of TARGETS) {
    it(`keeps and finds a ${target.os} target's chat record by that target's path and case rules`, () => {
      const lines: string[] = [];
      const worktreeRoot = worktreeFolderFor(target.root, target.project, 'abcd1234', target.os);
      const record = { ...chatRecord('abcd1234', worktreeRoot), projectPath: target.project, repositoryRoot: target.project };
      // the project's worktrees folder spelled in another case: another folder on a POSIX target, the same one on Windows
      const flavor = target.os === 'win32' ? path.win32 : path.posix;
      const placed = flavor.dirname(worktreeFolderFor(target.root, target.project, 'abcd1235', target.os));
      const otherCase = flavor.join(flavor.dirname(placed), flavor.basename(placed).toUpperCase(), 'abcd1235');
      const respelled = { ...chatRecord('abcd1235', otherCase), projectPath: target.project, repositoryRoot: target.project };
      const records = new WorktreeRecords(remoteChatRecord(() => [target.project], () => target.os), (line) => lines.push(line), () => target.os);
      records.apply([record, respelled]);
      expect(lines).toHaveLength(target.os === 'win32' ? 0 : 1);
      expect(records.liveChatRecords(target.project).map((kept) => kept.id)).toEqual(target.os === 'win32' ? ['abcd1234', 'abcd1235'] : ['abcd1234']);
      expect(records.liveChatRecordAt(worktreeRoot)?.id).toBe('abcd1234');
      // another folder on a case-sensitive target, the same folder on Windows
      expect(records.liveChatRecords(target.other).map((kept) => kept.id)).toEqual(target.os === 'win32' ? ['abcd1234', 'abcd1235'] : []);
    });
  }
});
