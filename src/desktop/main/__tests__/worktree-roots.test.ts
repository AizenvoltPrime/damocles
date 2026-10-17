import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatWorktreeRecord, WorktreeRecord, WorktreeRegistry } from '../../../core/worktrees/registry';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { WorktreeStateData } from '../../../shared/types/messages';
import { isFolderRoot, parseRootKey, rootKey } from '../../preload/folder-root';
import type { ShownFolder } from '../../preload/shell-channels';
import { confineExisting } from '../documents/confine';
import { chatRowWorktree } from '../worktrees/chat-rows';
import { RootSet, WorktreeRoots } from '../worktrees/roots';
import { setupArgs, setupShell } from '../worktrees/setup-terminal';
import { ShownFolderState, type SelectedChatPlace } from '../worktrees/shown-folder';

let dir: string;
let alpha: string;
let beta: string;

function registryOf(records: () => WorktreeRecord[]): WorktreeRegistry {
  const fake = {
    records,
    get: (id: string) => records().find((record) => record.id === id),
    liveChatRecords: (projectPath: string) => records().filter((record): record is ChatWorktreeRecord => record.kind === 'chat' && record.deletedAt === undefined && folderKey(record.projectPath) === folderKey(projectPath)),
    liveChatRecordAt: (folder: string) => records().find((record): record is ChatWorktreeRecord => record.kind === 'chat' && record.deletedAt === undefined && folderKey(record.workingFolder) === folderKey(folder)),
  };
  return fake as unknown as WorktreeRegistry;
}

function chatRecord(id: string, projectPath: string, overrides: Partial<ChatWorktreeRecord> = {}): ChatWorktreeRecord {
  const worktreeRoot = path.join(dir, 'worktrees', id);
  return { id, kind: 'chat', projectPath, repositoryRoot: projectPath, worktreeRoot, workingFolder: worktreeRoot, branch: `damocles/${id}`, index: 1, baseCommit: 'a'.repeat(40), createdAt: 1, ...overrides };
}

const STATE: WorktreeStateData = { phase: 'ready', place: 'worktree', canHandOff: true, branch: 'damocles/fix', baseBranch: 'main', behind: 2, targetRewritten: false };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-roots-'));
  alpha = path.join(dir, 'alpha');
  beta = path.join(dir, 'beta');
  for (const folder of [alpha, beta]) fs.mkdirSync(folder);
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']) {
    fs.mkdirSync(path.join(dir, 'worktrees', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'worktrees', id, 'file.txt'), id);
  }
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('folder roots', () => {
  it('keys a project folder by its project key and a worktree by project key and id, and parses them back', () => {
    expect(rootKey({ projectKey: 'p' })).toBe('p');
    const key = rootKey({ projectKey: 'p', worktreeId: 'abcd1234' });
    expect(parseRootKey(key)).toEqual({ projectKey: 'p', worktreeId: 'abcd1234' });
    expect(parseRootKey('p')).toEqual({ projectKey: 'p' });
    expect(parseRootKey('p\u0000../../etc')).toBeUndefined();
    expect(parseRootKey('p\u0000ABCD1234')).toBeUndefined();
    expect(parseRootKey(7)).toBeUndefined();
    expect(isFolderRoot({ projectKey: 'p', worktreeId: 'abcd1234', extra: 1 })).toBe(false);
    expect(isFolderRoot({ projectKey: '' })).toBe(false);
  });

  it('confines to the project folder and its live chat worktrees, and refuses adopted, deleted and another project\'s worktrees', async () => {
    const records: WorktreeRecord[] = [
      chatRecord('aaaaaaaa', alpha),
      chatRecord('bbbbbbbb', beta),
      chatRecord('cccccccc', alpha, { deletedAt: 5 }),
      { id: 'dddddddd', kind: 'adopted', projectPath: alpha, repositoryRoot: alpha, worktreeRoot: path.join(dir, 'worktrees', 'dddddddd'), workingFolder: path.join(dir, 'worktrees', 'dddddddd'), createdAt: 1 },
    ];
    const projects = [{ key: folderKey(alpha), fsPath: alpha, name: 'alpha' }, { key: folderKey(beta), fsPath: beta, name: 'beta' }];
    const roots = new WorktreeRoots({ projects: () => projects, registry: () => registryOf(() => records) });
    const a = folderKey(alpha);
    const own = roots.resolve(rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' }));
    expect(own?.fsPath).toBe(path.join(dir, 'worktrees', 'aaaaaaaa'));
    expect(own && (await confineExisting(own, 'file.txt')).ok).toBe(true);
    expect(own && (await confineExisting(own, '../bbbbbbbb/file.txt'))).toEqual({ ok: false, reason: 'outside' });
    // another project's worktree named under this project, a deleted one, an adopted one and an unknown id
    for (const id of ['bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee']) expect(roots.resolve(rootKey({ projectKey: a, worktreeId: id }))).toBeUndefined();
    // a project that is not open
    expect(roots.resolve(rootKey({ projectKey: folderKey(path.join(dir, 'gamma')), worktreeId: 'aaaaaaaa' }))).toBeUndefined();
    expect(roots.resolve(a)?.fsPath).toBe(alpha);
    expect(roots.all().map((root) => root.key)).toEqual([a, folderKey(beta), rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' }), rootKey({ projectKey: folderKey(beta), worktreeId: 'bbbbbbbb' })]);
    // a worktree being deleted is no root until its close is undone
    const closing = roots.close('aaaaaaaa');
    expect(roots.resolve(rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' }))).toBeUndefined();
    expect(roots.all().some((root) => root.worktree?.id === 'aaaaaaaa')).toBe(false);
    closing.dispose();
    expect(roots.resolve(rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' }))).toBeDefined();
  });
});

describe('ShownFolderState', () => {
  it('follows the selected chat\'s working folder, and Show project folder lasts until another chat is selected (D31)', () => {
    const records: WorktreeRecord[] = [chatRecord('aaaaaaaa', alpha)];
    const a = folderKey(alpha);
    const projects = [{ key: a, fsPath: alpha, name: 'alpha' }];
    const roots = new WorktreeRoots({ projects: () => projects, registry: () => registryOf(() => records) });
    let selected: SelectedChatPlace | undefined = { chatId: 'plain' };
    const state = new ShownFolderState({ roots, selectedChat: () => selected, finish: () => ({ busy: false, hasRemote: true, detachedTarget: false }), newChatIn: (record) => ({ projectKey: a, worktreeId: record.id }) });
    const events: ShownFolder[] = [];
    state.onDidChange((shown) => events.push(shown));
    state.refresh();
    expect(state.get(a)).toMatchObject({ rootKey: a, fsPath: alpha, canShowWorktree: false });
    expect(state.get(a)?.worktree).toBeUndefined();

    const worktreeKey = rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' });
    selected = { chatId: 'wt', worktreeId: 'aaaaaaaa', state: STATE };
    state.refresh();
    expect(state.get(a)).toMatchObject({ rootKey: worktreeKey, root: { projectKey: a, worktreeId: 'aaaaaaaa' }, canShowWorktree: true });
    expect(state.get(a)?.worktree).toEqual({ worktreeId: 'aaaaaaaa', chatId: 'wt', branch: 'damocles/fix', baseBranch: 'main', behind: 2, targetRewritten: false, place: 'worktree', finish: { busy: false, hasRemote: true, detachedTarget: false }, newChatIn: { projectKey: a, worktreeId: 'aaaaaaaa' } });
    expect(events.at(-1)?.rootKey).toBe(worktreeKey);

    expect(state.show(a, 'project')).toBe(true);
    expect(state.get(a)).toMatchObject({ rootKey: a, canShowWorktree: true });
    expect(state.rootKeyOf(a)).toBe(a);
    expect(state.show(a, 'worktree')).toBe(true);
    expect(state.rootKeyOf(a)).toBe(worktreeKey);
    state.show(a, 'project');

    // another chat selected, then the worktree chat again: the override is gone
    selected = { chatId: 'plain' };
    state.refresh();
    selected = { chatId: 'wt', worktreeId: 'aaaaaaaa', state: STATE };
    state.refresh();
    expect(state.rootKeyOf(a)).toBe(worktreeKey);

    // a chat handed back works in the project folder and still offers its worktree
    selected = { chatId: 'wt', worktreeId: 'aaaaaaaa', state: { ...STATE, place: 'project' } };
    state.refresh();
    expect(state.get(a)).toMatchObject({ rootKey: a, canShowWorktree: true, worktree: { place: 'project' } });

    // a deleted worktree shows the project folder with nothing to switch to
    records[0] = { ...records[0]!, deletedAt: 9 };
    state.refresh();
    expect(state.get(a)).toMatchObject({ rootKey: a, canShowWorktree: false });
    expect(state.show(a, 'worktree')).toBe(false);
  });
});

describe('ShownFolderState root changes', () => {
  it('says the shown root changed only when its root key did, not when the worktree\'s chat starts working or its branch moves', () => {
    const records: WorktreeRecord[] = [chatRecord('aaaaaaaa', alpha)];
    const a = folderKey(alpha);
    const roots = new WorktreeRoots({ projects: () => [{ key: a, fsPath: alpha, name: 'alpha' }], registry: () => registryOf(() => records) });
    let selected: SelectedChatPlace | undefined = { chatId: 'wt', worktreeId: 'aaaaaaaa', state: STATE };
    let busy = false;
    let available = true;
    const state = new ShownFolderState({
      roots,
      selectedChat: () => selected,
      finish: () => ({ busy, hasRemote: true, detachedTarget: false }),
      newChatIn: (record) => (available ? { projectKey: a, worktreeId: record.id } : undefined),
    });
    const changes: Array<[string, boolean]> = [];
    state.onDidChange((shown, rootChanged) => changes.push([shown.rootKey, rootChanged]));
    const worktreeKey = rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' });
    state.refresh();
    busy = true;
    state.refresh();
    selected = { ...selected, state: { ...STATE, behind: 5 } };
    state.refresh();
    state.show(a, 'project');
    expect(changes).toEqual([[worktreeKey, true], [worktreeKey, false], [worktreeKey, false], [a, true]]);
    // New Chat in This Worktree follows main's availability for the worktree
    available = false;
    expect(state.get(a)?.worktree?.newChatIn).toBeUndefined();
  });
});

describe('root keys', () => {
  it('names a closing worktree\'s branch for its tabs, though the worktree is no longer a root', () => {
    const records: WorktreeRecord[] = [chatRecord('aaaaaaaa', alpha), chatRecord('bbbbbbbb', beta)];
    const a = folderKey(alpha);
    const roots = new WorktreeRoots({ projects: () => [{ key: a, fsPath: alpha, name: 'alpha' }], registry: () => registryOf(() => records) });
    const key = rootKey({ projectKey: a, worktreeId: 'aaaaaaaa' });
    const closing = roots.close('aaaaaaaa');
    expect(roots.resolve(key)).toBeUndefined();
    expect(roots.branchOf(key)).toBe('damocles/aaaaaaaa');
    closing.dispose();
    // another project's worktree named under this project, and a project folder
    expect(roots.branchOf(rootKey({ projectKey: a, worktreeId: 'bbbbbbbb' }))).toBeUndefined();
    expect(roots.branchOf(a)).toBeUndefined();
    expect(roots.projectRoots().map((root) => root.key)).toEqual([a]);
  });

  it('reports a change of the root set only when a root key joined or left it', () => {
    const set = new RootSet();
    expect(set.update(['a', 'a\u0000abcd1234'])).toEqual({ added: ['a', 'a\u0000abcd1234'], removed: [] });
    expect(set.update(['a', 'a\u0000abcd1234'])).toBeUndefined();
    expect(set.update(['a'])).toEqual({ added: [], removed: ['a\u0000abcd1234'] });
  });
});

describe('chat rows', () => {
  it('marks a live, handed-back, deleted and pending worktree chat, and a chat of a deleted worktree project', () => {
    const live = chatRecord('aaaaaaaa', alpha);
    const records: WorktreeRecord[] = [
      live,
      chatRecord('cccccccc', alpha, { deletedAt: 3 }),
      { id: 'dddddddd', kind: 'adopted', projectPath: alpha, repositoryRoot: alpha, worktreeRoot: path.join(dir, 'gone'), workingFolder: path.join(dir, 'gone', 'review'), createdAt: 1, deletedAt: 4 },
    ];
    const deps = { registry: registryOf(() => records), finish: () => ({ busy: true, hasRemote: false, detachedTarget: false }), baseBranch: () => 'main' };
    expect(chatRowWorktree({ stored: { worktree: { worktreeId: 'aaaaaaaa', place: 'worktree' } } }, deps)).toEqual({
      worktree: { worktreeId: 'aaaaaaaa', branch: 'damocles/aaaaaaaa', status: 'live', baseBranch: 'main', finish: { busy: true, hasRemote: false, detachedTarget: false } },
      readOnly: false,
    });
    expect(chatRowWorktree({ stored: { worktree: { worktreeId: 'aaaaaaaa', place: 'project' } } }, deps).worktree?.status).toBe('inProjectFolder');
    expect(chatRowWorktree({ stored: { worktree: { worktreeId: 'cccccccc', place: 'worktree' } } }, deps)).toEqual({ worktree: { worktreeId: 'cccccccc', branch: 'damocles/cccccccc', status: 'deleted' }, readOnly: true });
    // handed back to the project folder before its worktree went: a normal chat, as core binds it
    expect(chatRowWorktree({ stored: { worktree: { worktreeId: 'cccccccc', place: 'project' } } }, deps)).toEqual({ readOnly: false });
    // a loaded chat core bound read-only stays read-only whatever place its state names
    const readOnly = { ...STATE, phase: 'deleted' as const, place: 'project' as const };
    expect(chatRowWorktree({ live: { state: readOnly }, stored: { worktree: { worktreeId: 'cccccccc', place: 'worktree' } } }, deps)).toEqual({ worktree: { worktreeId: 'cccccccc', branch: 'damocles/cccccccc', status: 'deleted' }, readOnly: true });
    expect(chatRowWorktree({ live: { state: readOnly }, stored: {} }, deps)).toEqual({ worktree: { branch: '', status: 'deleted' }, readOnly: true });
    expect(chatRowWorktree({ live: { state: { ...STATE, phase: 'pending', branch: 'main' } } }, deps)).toEqual({ worktree: { status: 'pending', branch: 'main' }, readOnly: false });
    expect(chatRowWorktree({ stored: { listedFrom: path.join(dir, 'gone', 'review') } }, deps)).toEqual({
      worktree: { worktreeId: 'dddddddd', branch: '', status: 'deleted', fromProject: 'review' },
      readOnly: true,
    });
    expect(chatRowWorktree({ stored: {} }, deps)).toEqual({ readOnly: false });
  });
});

describe('the Setup terminal', () => {
  it('starts PowerShell from an absolute path on Windows, pwsh 7 first, and $SHELL or bash elsewhere (rule 23)', () => {
    expect(setupShell('win32', { SystemRoot: 'C:\\Windows' }, undefined)).toEqual({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', kind: 'powershell' });
    expect(setupShell('win32', { SystemRoot: 'C:\\Windows' }, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')?.file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(setupShell('linux', { SHELL: '/usr/bin/zsh' }, undefined)).toEqual({ file: '/usr/bin/zsh', kind: 'posix' });
    expect(setupShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, undefined)).toEqual({ file: '/opt/homebrew/bin/fish', kind: 'fish' });
    expect(setupShell('linux', { SHELL: 'zsh', PATH: '' }, undefined)).toBeUndefined();
    // a login shell that does not read POSIX syntax runs no setup script; bash from an absolute PATH folder does
    for (const shell of ['/usr/bin/tcsh', '/usr/bin/nu', '/usr/bin/xonsh', '/usr/bin/elvish']) expect(setupShell('linux', { SHELL: shell, PATH: '' }, undefined)).toBeUndefined();
    expect(setupShell('linux', { SHELL: '/bin/dash' }, undefined)).toEqual({ file: '/bin/dash', kind: 'posix' });
  });

  it('runs the commands one after another, marking each start and end with the tab\'s nonce, and stops at the first failure', () => {
    const start = "printf '\\033]633;C;%s\\007' \"$__damocles_nonce\"";
    const end = 'damocles_rc=$?; printf \'\\033]633;D;%s;%s\\007\' "$damocles_rc" "$__damocles_nonce"; [ "$damocles_rc" -eq 0 ] || exit "$damocles_rc"';
    const posix = setupArgs({ file: '/bin/bash', kind: 'posix' }, ['npm ci', 'npm run build # comment']);
    expect(posix[0]).toBe('-c');
    expect(posix[1]!.split('\n')).toEqual(['__damocles_nonce=$DAMOCLES_NONCE; unset DAMOCLES_NONCE', start, 'npm ci', end, start, 'npm run build # comment', end]);
    const fish = setupArgs({ file: '/usr/bin/fish', kind: 'fish' }, ['make']);
    expect(fish[1]!.split('\n')).toEqual([
      'set -l __damocles_nonce $DAMOCLES_NONCE; set -e DAMOCLES_NONCE',
      "printf '\\033]633;C;%s\\007' $__damocles_nonce",
      'make',
      "set -l damocles_rc $status; printf '\\033]633;D;%s;%s\\007' $damocles_rc $__damocles_nonce; test $damocles_rc -eq 0; or exit $damocles_rc",
    ]);
    const powershell = setupArgs({ file: 'pwsh.exe', kind: 'powershell' }, ['npm ci']);
    // process-scope Bypass, so npm.ps1 runs under Windows PowerShell 5.1's default Restricted policy
    expect(powershell.slice(0, 4)).toEqual(['-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(powershell[4]!, 'base64').toString('utf16le');
    expect(script.split('\n')).toEqual([
      '$__damoclesNonce = $env:DAMOCLES_NONCE',
      '$env:DAMOCLES_NONCE = $null',
      '$global:LASTEXITCODE = 0',
      '[Console]::Write("$([char]0x1b)]633;C;$__damoclesNonce$([char]7)")',
      'npm ci',
      '$__damoclesRc = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
      '[Console]::Write("$([char]0x1b)]633;D;$__damoclesRc;$__damoclesNonce$([char]7)")',
      'if ($__damoclesRc -ne 0) { exit $__damoclesRc }',
      'exit 0',
    ]);
  });
});
