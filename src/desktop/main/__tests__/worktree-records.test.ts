import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreeFolderFor } from '../../../core/worktrees/records';
import { WorktreeRecords } from '../worktrees/records';

const ROOT = path.resolve('/home/u/.damocles/worktrees');
const PROJECT = path.resolve('/work/alpha');

function chatRecord(id: string, worktreeRoot: string): Record<string, unknown> {
  return { id, kind: 'chat', projectPath: PROJECT, repositoryRoot: PROJECT, worktreeRoot, workingFolder: worktreeRoot, branch: 'damocles/fix', index: 1, baseCommit: 'a'.repeat(40), createdAt: 1 };
}

describe('core\'s worktree records as main reads them', () => {
  it('keeps a chat record at the folder the registry rule names, so trust follows it to its project', () => {
    const lines: string[] = [];
    const records = new WorktreeRecords(ROOT, (line) => lines.push(line));
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
    const records = new WorktreeRecords(ROOT, (line) => lines.push(line));
    const elsewhere = path.resolve('/other-repo');
    records.apply([chatRecord('abcd1234', elsewhere), { id: 'x', kind: 'nonsense' }]);
    expect(records.records()).toEqual([]);
    expect(records.liveChatRecordAt(elsewhere)).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/dropped a worktree record core published/);
  });
});
