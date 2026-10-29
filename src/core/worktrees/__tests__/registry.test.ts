import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { branchBaseName, branchSlug } from '../slug';
import { newWorktreeId, WorktreeRegistry, type ChatWorktreeRecord } from '../registry';
import { worktreeFolderFor } from '../records';
import { scanLeftovers } from '../leftovers';

// The bytes newWorktreeId draws, when a test sets them.
const R = vi.hoisted(() => ({ draws: [] as Buffer[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: (size: number) => (R.draws.length > 0 ? R.draws.shift()!.subarray(0, size) : actual.randomBytes(size)) };
});
import { installWorktreeProjectLookup, personalConfigRoot } from '../personal-config';
import { loadPermissionsByPriority } from '../../permission-handler/permission-settings';
import { syncPermissionRulesToSettings } from '../../chat-panel/settings-manager/utils';
import { localMcpConfigPath } from '../../chat-panel/settings-manager/managers/mcp-config-import';
import { ownedRuleFiles } from '../../pi-session/mcp/tool-name-migration';
import { settingsFolderOf } from '../../workspace-folders/folder-registry';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

let base: string;
let root: string;
let project: string;
const open: WorktreeRegistry[] = [];

beforeEach(() => {
  R.draws.length = 0;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-registry-')));
  root = path.join(base, 'worktrees');
  project = path.join(base, 'project');
});
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function registry(): WorktreeRegistry {
  const r = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined });
  open.push(r);
  return r;
}

function chat(id: string, overrides: Partial<ChatWorktreeRecord> = {}): Omit<ChatWorktreeRecord, 'index'> {
  const worktreeRoot = worktreeFolderFor(root, project, id);
  return { id, kind: 'chat', projectPath: project, repositoryRoot: project, worktreeRoot, workingFolder: worktreeRoot, branch: `damocles/${id}`, baseCommit: 'a'.repeat(40), createdAt: 1, ...overrides };
}

describe('WorktreeRegistry', () => {
  it('maps a working folder and its subfolders to the project, and nothing else', async () => {
    const r = registry();
    const record = await r.addChat(chat('aaaaaaaa'));
    expect(r.projectOf(record.workingFolder)).toBe(project);
    expect(r.projectOf(path.join(record.workingFolder, 'src'))).toBe(project);
    expect(r.projectOf(project)).toBeUndefined();
    expect(r.projectOf(path.join(base, 'other'))).toBeUndefined();
  });

  it('allocates the smallest free index and frees it on delete', async () => {
    const r = registry();
    expect((await r.addChat(chat('aaaaaaaa'))).index).toBe(1);
    expect((await r.addChat(chat('bbbbbbbb'))).index).toBe(2);
    await r.markDeleted('aaaaaaaa');
    expect((await r.addChat(chat('cccccccc'))).index).toBe(1);
  });

  it('sees another instance\'s write through the file, as a second process would', async () => {
    const a = registry();
    const b = registry();
    let changes = 0;
    b.onDidChange(() => changes++);
    await a.addChat(chat('aaaaaaaa'));
    b.reload();
    expect(b.get('aaaaaaaa')?.kind).toBe('chat');
    expect(changes).toBe(1);
    await b.update('aaaaaaaa', { lastAppliedTree: 'b'.repeat(40) });
    a.reload();
    expect((a.get('aaaaaaaa') as ChatWorktreeRecord).lastAppliedTree).toBe('b'.repeat(40));
    await a.update('aaaaaaaa', { lastAppliedTree: undefined });
    expect((a.get('aaaaaaaa') as ChatWorktreeRecord).lastAppliedTree).toBeUndefined();
  });

  it('drops a tampered chat record whose worktree lies outside the registry root', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    const file = path.join(root, 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    const outside = path.parse(base).root;
    data.records.push({ ...chat('bbbbbbbb'), index: 2, worktreeRoot: outside, workingFolder: outside });
    data.records.push({ ...chat('cccccccc'), index: 3, projectPath: path.join(root, 'x') });
    fs.writeFileSync(file, JSON.stringify(data));
    r.reload();
    expect(r.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
    expect(r.projectOf(path.join(base, 'other'))).toBeUndefined();
  });

  it('keeps a record whose project subfolder is spelled otherwise than git names it in the worktree, and drops one at another depth', async () => {
    const r = registry();
    const repositoryRoot = path.dirname(project);
    const sub = chat('aaaaaaaa', { repositoryRoot, projectPath: path.join(repositoryRoot, 'SUBFOL~1') });
    await r.addChat({ ...sub, worktreeRoot: worktreeFolderFor(root, sub.projectPath, 'aaaaaaaa'), workingFolder: path.join(worktreeFolderFor(root, sub.projectPath, 'aaaaaaaa'), 'Sub Folder Name') });
    const file = path.join(root, 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    const deeper = worktreeFolderFor(root, sub.projectPath, 'bbbbbbbb');
    data.records.push({ ...sub, id: 'bbbbbbbb', index: 2, worktreeRoot: deeper, workingFolder: path.join(deeper, 'Sub Folder Name', 'deeper') });
    fs.writeFileSync(file, JSON.stringify(data));
    r.reload();
    expect(r.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
  });

  it('keeps the records it last read when registry.json stops parsing, refuses writes, and says so once', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    const errors: string[] = [];
    r.onDidBecomeUnreadable((error) => errors.push(error));
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, '{ "version": 1, "records": [');
    r.reload();
    r.reload();
    expect(r.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
    expect(r.unreadable()).toMatch(/not valid JSON/);
    expect(errors).toHaveLength(1);
    await expect(r.addChat(chat('bbbbbbbb'))).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "version": 1, "records": [');
    const fresh = registry();
    expect(fresh.records()).toEqual([]);
    expect(fresh.unreadable()).toMatch(/not valid JSON/);
  });

  it('serves the records an earlier instance last read while registry.json does not parse, checked by the rule, and refuses writes', async () => {
    const before = registry();
    await before.addChat(chat('aaaaaaaa'));
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, '{ "version": 1, "records": [');
    before.reload();
    const outside = path.parse(base).root;
    const tampered = { ...chat('bbbbbbbb'), index: 2, worktreeRoot: outside, workingFolder: outside };
    const next = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined, lastRecords: [...before.records(), tampered] });
    open.push(next);
    expect(next.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
    expect(next.projectOf(before.records()[0]!.workingFolder)).toBe(project);
    expect(next.unreadable()).toMatch(/not valid JSON/);
    await expect(next.markUsed('aaaaaaaa')).rejects.toThrow(/not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: [] }));
    next.reload();
    expect(next.records()).toEqual([]);
    expect(next.unreadable()).toBeUndefined();
  });

  it('reads registry.json over the records an earlier instance passes while the file parses', async () => {
    const before = registry();
    await before.addChat(chat('aaaaaaaa'));
    const kept = before.records();
    await before.markDeleted('aaaaaaaa');
    const next = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined, lastRecords: kept });
    open.push(next);
    expect(next.get('aaaaaaaa')?.deletedAt).toBeDefined();
  });

  it('removes only the named records that are still deleted, and refuses while registry.json does not parse', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    await r.addChat(chat('bbbbbbbb'));
    await r.addChat(chat('cccccccc'));
    await r.markDeleted('aaaaaaaa');
    await r.markDeleted('cccccccc');
    await r.removeDeleted(['aaaaaaaa', 'bbbbbbbb']);
    expect(r.records().map((rec) => rec.id)).toEqual(['bbbbbbbb', 'cccccccc']);
    expect(registry().records().map((rec) => rec.id)).toEqual(['bbbbbbbb', 'cccccccc']);
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, '{ "version": 1, "records": [');
    r.reload();
    await expect(r.removeDeleted(['cccccccc'])).rejects.toThrow(/not valid JSON/);
    expect(r.records().map((rec) => rec.id)).toEqual(['bbbbbbbb', 'cccccccc']);
  });

  it('removes a project\'s folder under the registry root once it holds no worktree, and never while a live record names one', async () => {
    const r = registry();
    const live = await r.addChat(chat('aaaaaaaa'));
    const projectFolder = path.dirname(live.worktreeRoot);
    fs.mkdirSync(live.worktreeRoot, { recursive: true });
    fs.rmSync(live.worktreeRoot, { recursive: true });
    await r.removeEmptyProjectFolder(project);
    expect(fs.existsSync(projectFolder)).toBe(true);
    await r.markDeleted('aaaaaaaa');
    await r.removeEmptyProjectFolder(project);
    expect(fs.existsSync(projectFolder)).toBe(false);
    await r.removeEmptyProjectFolder(project);
    expect(fs.existsSync(projectFolder)).toBe(false);
  });

  it('keeps a project\'s folder that still holds a folder, and one whose registry.json does not parse', async () => {
    const r = registry();
    const record = await r.addChat(chat('aaaaaaaa'));
    await r.markDeleted('aaaaaaaa');
    const projectFolder = path.dirname(record.worktreeRoot);
    fs.mkdirSync(path.join(projectFolder, 'zzzzzzzz'), { recursive: true });
    await r.removeEmptyProjectFolder(project);
    expect(fs.existsSync(path.join(projectFolder, 'zzzzzzzz'))).toBe(true);
    fs.rmdirSync(path.join(projectFolder, 'zzzzzzzz'));
    fs.writeFileSync(path.join(root, 'registry.json'), '{ "version": 1, "records": [');
    r.reload();
    await expect(r.removeEmptyProjectFolder(project)).rejects.toThrow(/not valid JSON/);
    expect(fs.existsSync(projectFolder)).toBe(true);
  });

  it('writes records this version cannot read back unchanged, so two app versions can share the file', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    const file = path.join(root, 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    const future = { id: 'cccccccc', kind: 'remote', host: 'example', createdAt: 5 };
    data.records.push(future);
    fs.writeFileSync(file, JSON.stringify(data));
    r.reload();
    expect(r.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
    await r.addChat(chat('bbbbbbbb'));
    await r.markDeleted('aaaaaaaa');
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: Array<{ id: string }> };
    expect(written.records.map((rec) => rec.id).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(written.records.find((rec) => rec.id === 'cccccccc')).toEqual(future);
  });

  it('never gives a new chat worktree an index a record of another app version holds', async () => {
    const r = registry();
    const file = path.join(root, 'registry.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, records: [{ id: 'dddddddd', kind: 'chat', projectPath: project, index: 1, futureField: true }] }));
    r.reload();
    expect((await r.addChat(chat('aaaaaaaa'))).index).toBe(2);
  });

  it('lists a project\'s chat records and only the adopted records whose folder is gone', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    const live = path.join(base, 'adopted-live');
    fs.mkdirSync(live);
    await r.upsertAdopted({ worktreeRoot: live, workingFolder: live, repositoryRoot: project, projectPath: project });
    const gone = await r.upsertAdopted({ worktreeRoot: path.join(base, 'gone'), workingFolder: path.join(base, 'gone'), repositoryRoot: project, projectPath: project });
    expect(r.recordsOfProject(project).map((rec) => rec.id).sort()).toEqual(['aaaaaaaa', gone.id].sort());
    expect(r.projectOf(live)).toBeUndefined();
  });

  it('revives a deleted adopted record when its worktree is opened again, rather than adding a second one', async () => {
    const r = registry();
    const folder = path.join(base, 'adopted');
    fs.mkdirSync(folder);
    const first = await r.upsertAdopted({ worktreeRoot: folder, workingFolder: folder, repositoryRoot: project, projectPath: project });
    await r.markDeleted(first.id);
    const again = await r.upsertAdopted({ worktreeRoot: folder, workingFolder: folder, repositoryRoot: project, projectPath: project });
    expect(again.id).toBe(first.id);
    expect(r.records()).toHaveLength(1);
    expect(r.get(first.id)?.deletedAt).toBeUndefined();
  });

  it('serves only validated records after its own write', async () => {
    const r = registry();
    const folder = path.join(base, 'adopted');
    // A working folder outside its worktree fails validation, so the file keeps it as unreadable and memory never uses it.
    await r.upsertAdopted({ worktreeRoot: folder, workingFolder: path.join(base, 'elsewhere'), repositoryRoot: project });
    expect(r.records()).toEqual([]);
    expect(r.foreignWorktreeRoots()).toEqual([folder]);
  });

  it('keeps a pending base through the file and drops a malformed one\'s record from use', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    await r.update('aaaaaaaa', { pendingBase: { commit: 'c'.repeat(40), side: 'project' } });
    const fresh = registry();
    expect((fresh.get('aaaaaaaa') as ChatWorktreeRecord).pendingBase).toEqual({ commit: 'c'.repeat(40), side: 'project' });
    await fresh.settlePendingBase('aaaaaaaa', 'd'.repeat(40), true);
    expect((fresh.get('aaaaaaaa') as ChatWorktreeRecord).baseCommit).toBe('a'.repeat(40));
    await fresh.settlePendingBase('aaaaaaaa', 'c'.repeat(40), true);
    expect(fresh.get('aaaaaaaa')).toMatchObject({ baseCommit: 'c'.repeat(40) });
    expect((fresh.get('aaaaaaaa') as ChatWorktreeRecord).pendingBase).toBeUndefined();
    const file = path.join(root, 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: Array<Record<string, unknown>> };
    data.records[0]!['pendingBase'] = { commit: 'c'.repeat(40), side: 'elsewhere' };
    fs.writeFileSync(file, JSON.stringify(data));
    fresh.reload();
    expect(fresh.records()).toEqual([]);
  });

  it('carries a malformed pending base unchanged through writes, and keeps a valid one through another record\'s write', async () => {
    const r = registry();
    await r.addChat(chat('aaaaaaaa'));
    await r.addChat(chat('bbbbbbbb'));
    await r.update('aaaaaaaa', { pendingBase: { commit: 'c'.repeat(40), side: 'worktree' } });
    const file = path.join(root, 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: Array<Record<string, unknown>> };
    const malformed = { ...data.records[1]!, pendingBase: { commit: 'c'.repeat(7), side: 'worktree' } };
    data.records[1] = malformed;
    fs.writeFileSync(file, JSON.stringify(data));
    r.reload();
    expect(r.records().map((rec) => rec.id)).toEqual(['aaaaaaaa']);
    await r.markUsed('aaaaaaaa');
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: Array<Record<string, unknown>> };
    expect(written.records.find((rec) => rec['id'] === 'bbbbbbbb')).toEqual(malformed);
    expect(written.records.find((rec) => rec['id'] === 'aaaaaaaa')?.['pendingBase']).toEqual({ commit: 'c'.repeat(40), side: 'worktree' });
  });

  it('draws every id character from the 36 equally often, redrawing bytes past the last full multiple of 36', () => {
    R.draws.push(Buffer.from([255, 252, 0, 1, 2, 3, 4, 5]), Buffer.from([251, 6]));
    expect(newWorktreeId()).toBe(['0', '1', '2', '3', '4', '5', (251 % 36).toString(36), '6'].join(''));
    expect(R.draws).toEqual([]);
  });

  it('routes personal files of a worktree to its project and every other folder to itself', async () => {
    const r = registry();
    const record = await r.addChat(chat('aaaaaaaa'));
    const installed = installWorktreeProjectLookup(r);
    expect(personalConfigRoot(record.workingFolder)).toBe(project);
    expect(personalConfigRoot(project)).toBe(project);
    installed.dispose();
    expect(personalConfigRoot(record.workingFolder)).toBe(record.workingFolder);
  });
});

describe('the leftover scan', () => {
  const later = Date.now() + 60 * 60 * 1000;

  it('counts a worktree another app version recorded as registered', async () => {
    const r = registry();
    const foreignRoot = path.join(root, 'project-abcdef', 'zzzzzzzz');
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ version: 2, records: [{ id: 'zzzzzzzz', kind: 'remote', worktreeRoot: foreignRoot }] }));
    r.reload();
    expect(await scanLeftovers({ registry: r, git: undefined, projects: [project], isTrusted: () => true, now: later })).toEqual([]);
  });

  it('keeps an adopted record live while the drive or parent folder of its worktree is missing', async () => {
    const r = registry();
    const unmounted = path.join(base, 'unmounted-drive', 'wt');
    const removed = path.join(base, 'removed-wt');
    const a = await r.upsertAdopted({ worktreeRoot: unmounted, workingFolder: unmounted, repositoryRoot: project, projectPath: project });
    const b = await r.upsertAdopted({ worktreeRoot: removed, workingFolder: removed, repositoryRoot: project, projectPath: project });
    const findings = await scanLeftovers({ registry: r, git: undefined, projects: [project], isTrusted: () => true, now: later });
    expect(r.get(a.id)?.deletedAt).toBeUndefined();
    expect(r.get(b.id)?.deletedAt).toBeTypeOf('number');
    expect(findings).toEqual([{ path: removed, reason: 'missingFolder' }]);
  });

  it('reports no worktree of a project that is not open, and still marks a missing one deleted', async () => {
    const r = registry();
    const gone = await r.addChat(chat('aaaaaaaa'));
    const unused = await r.addChat(chat('bbbbbbbb'));
    fs.mkdirSync(unused.worktreeRoot, { recursive: true });
    expect(await scanLeftovers({ registry: r, git: undefined, projects: [], isTrusted: () => true, now: later })).toEqual([]);
    expect(r.get(gone.id)?.deletedAt).toBeTypeOf('number');
    expect((await scanLeftovers({ registry: r, git: undefined, projects: [project], isTrusted: () => true, now: later })).map((f) => f.reason)).toEqual(['noChat']);
  });
});

describe('personal files of a worktree chat (D34)', () => {
  it('reads and writes the project folder\'s personal files for every reader and writer, and shared files from the worktree', async () => {
    const r = registry();
    const record = await r.addChat(chat('aaaaaaaa'));
    fs.mkdirSync(path.join(project, '.damocles'), { recursive: true });
    fs.mkdirSync(path.join(record.workingFolder, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(project, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    fs.writeFileSync(path.join(record.workingFolder, '.damocles', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
    const installed = installWorktreeProjectLookup(r);
    try {
      const files = await loadPermissionsByPriority(record.workingFolder);
      expect(files[0]!.deny).toEqual(['Bash(rm:*)']);
      expect(files.every((f) => f.root !== project)).toBe(true);
      expect(files.some((f) => f.allow.includes('Read'))).toBe(true);
      await syncPermissionRulesToSettings([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }], record.workingFolder);
      expect(fs.readFileSync(path.join(project, '.damocles', 'settings.local.json'), 'utf8')).toContain('Bash(ls:*)');
      expect(fs.existsSync(path.join(record.workingFolder, '.damocles', 'settings.local.json'))).toBe(false);
      expect(localMcpConfigPath(record.workingFolder)).toBe(path.join(project, '.damocles', 'mcp.local.json'));
      expect(ownedRuleFiles(record.workingFolder).at(-1)?.path).toBe(path.join(project, '.damocles', 'settings.local.json'));
      const target = { key: record.workingFolder, fsPath: record.workingFolder, name: 'x', label: 'x', projectScope: true };
      expect(settingsFolderOf(target)).toEqual({ path: record.workingFolder, personalPath: project });
    } finally {
      installed.dispose();
    }
  });
});

describe('branch names', () => {
  it('slugs the first five words to lowercase ASCII, at most 40 characters', () => {
    expect(branchSlug('Fix the Login page, now please and more', 'x')).toBe('fix-the-login-page-now');
    expect(branchSlug('Refactor supercalifragilisticexpialidocious authentication middleware everywhere', 'x').length).toBeLessThanOrEqual(40);
    expect(branchBaseName('', 'fix')).toBe('damocles/fix');
    expect(branchBaseName('ax/', 'fix')).toBe('ax/fix');
  });

  it('falls back to chat-<id> for a Greek prompt', () => {
    expect(branchSlug('Διόρθωσε τη σελίδα σύνδεσης', 'abcd1234')).toBe('chat-abcd1234');
  });
});
