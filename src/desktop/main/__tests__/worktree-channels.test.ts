import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {}, ipcMain: { handle: vi.fn(), on: vi.fn() }, dialog: { showMessageBox: vi.fn() } }));

import type { OverlayRequest, WorktreeDialog, WorktreeDialogRequest } from '../../preload/overlay-channels';
import { boundWorktreeDialog, parseOverlayAnswer, parseOverlayRequest } from '../overlay';
import { parseNewChatInWorktree, parseNewChatWorktree, parseShowFolder, parseWorktreeFinish } from '../shell';
import { TrustStore } from '../trust-store';
import { cancelAnswer, createWorktreeDialogAsker } from '../worktrees/worktree-dialogs';

const anchor = { x: 1, y: 2, width: 3, height: 4 };

function dialog(value: WorktreeDialog): WorktreeDialogRequest {
  return boundWorktreeDialog(value);
}

describe('worktree channels', () => {
  it('validates the shell\'s worktree requests: a full branch refname, a known action, a worktree id main issues', () => {
    expect(parseNewChatWorktree({ startRef: 'refs/heads/main', bringChanges: true })).toEqual({ startRef: 'refs/heads/main', bringChanges: true });
    expect(parseNewChatWorktree({ startRef: 'refs/remotes/origin/feat/a', bringChanges: false })).toBeDefined();
    expect(parseNewChatWorktree({ startRef: 'refs/tags/v1', bringChanges: false })).toBeUndefined();
    expect(parseNewChatWorktree({ startRef: 'main', bringChanges: false })).toBeUndefined();
    // A detached HEAD's option starts from HEAD's commit; no other bare name is a start ref.
    expect(parseNewChatWorktree({ startRef: 'HEAD', bringChanges: true })).toEqual({ startRef: 'HEAD', bringChanges: true });
    expect(parseNewChatWorktree({ startRef: 'HEAD~1', bringChanges: false })).toBeUndefined();
    expect(parseNewChatWorktree({ startRef: 'refs/heads/../x', bringChanges: false })).toBeUndefined();
    expect(parseNewChatWorktree({ startRef: 'refs/heads/main', bringChanges: 'yes' })).toBeUndefined();
    expect(parseNewChatWorktree({ startRef: 'refs/heads/main', bringChanges: true, extra: 1 })).toBeUndefined();
    expect(parseShowFolder({ projectKey: 'p', show: 'worktree' })).toEqual({ projectKey: 'p', show: 'worktree' });
    expect(parseShowFolder({ projectKey: 'p', show: 'elsewhere' })).toBeUndefined();
    expect(parseWorktreeFinish({ projectKey: 'p', worktreeId: 'abcd1234', action: 'merge' })).toEqual({ projectKey: 'p', worktreeId: 'abcd1234', action: 'merge' });
    expect(parseWorktreeFinish({ projectKey: 'p', worktreeId: '../../x', action: 'merge' })).toBeUndefined();
    expect(parseWorktreeFinish({ projectKey: 'p', worktreeId: 'abcd1234', action: 'rm' })).toBeUndefined();
    // New Chat in This Worktree names a worktree by the id main issued, never by a path
    expect(parseNewChatInWorktree({ projectKey: 'p', worktreeId: 'abcd1234' })).toEqual({ projectKey: 'p', worktreeId: 'abcd1234' });
    expect(parseNewChatInWorktree({ projectKey: 'p', worktreeId: 'C:\\wt\\abcd1234' })).toBeUndefined();
    expect(parseNewChatInWorktree({ projectKey: '', worktreeId: 'abcd1234' })).toBeUndefined();
    expect(parseNewChatInWorktree({ projectKey: 'p', worktreeId: 'abcd1234', path: '/x' })).toBeUndefined();
  });

  it('opens the New menu only as its shape allows, and takes only a well-formed answer', () => {
    const request = parseOverlayRequest({ kind: 'newChatMenu', anchor, projectKey: 'p', projectName: 'alpha', shortcut: 'Ctrl+N' });
    expect(request).toEqual({ kind: 'newChatMenu', anchor, projectKey: 'p', projectName: 'alpha', shortcut: 'Ctrl+N' });
    expect(parseOverlayRequest({ kind: 'newChatMenu', anchor, projectKey: '', projectName: 'alpha', shortcut: '' })).toBeUndefined();
    expect(parseOverlayRequest({ kind: 'newChatMenu', anchor, projectKey: 'p', projectName: 'alpha', shortcut: 'Ctrl+N', extra: 1 })).toBeUndefined();
    // only main asks a worktree dialog
    expect(parseOverlayRequest({ kind: 'worktreeDialog', dialog: 'refusal', action: 'apply', files: [] })).toBeUndefined();
    const menu = request as OverlayRequest;
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'plain' }, menu)).toEqual({ kind: 'newChatMenu', choice: 'plain' });
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/feat/a', bringChanges: false }, menu)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/feat/a', bringChanges: false });
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'worktree', startRef: 'C:\\x', bringChanges: false }, menu)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'worktree', startRef: 'HEAD', bringChanges: false }, menu)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'HEAD', bringChanges: false });
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'worktree', startRef: 'ORIG_HEAD', bringChanges: false }, menu)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'plain', startRef: 'refs/heads/main' }, menu)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: 'abcd1234' }, menu)).toEqual({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: 'abcd1234' });
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: '../x' }, menu)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: 'abcd1234', startRef: 'refs/heads/main' }, menu)).toBeUndefined();
  });

  it('accepts each worktree dialog\'s own answers only, for the dialog main issued', () => {
    const remove = dialog({ dialog: 'delete', path: '/w', branch: 'damocles/x', uncommitted: [{ path: 'a.ts', letter: 'M' }], submoduleChanges: [], unmergedCommits: [], deleteBranchDefault: true, deleteBranchLocked: true });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'delete', choice: 'delete', deleteBranch: true }, remove)).toEqual({ kind: 'worktreeDialog', dialog: 'delete', choice: 'delete', deleteBranch: true });
    // a locked checkbox cannot change, and another dialog's answer is refused
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'delete', choice: 'delete', deleteBranch: false }, remove)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'setupReview', choice: 'run' }, remove)).toBeUndefined();
    const merge = dialog({ dialog: 'mergeMessage', branch: 'damocles/x', target: 'main', files: [{ path: 'a.ts', letter: 'A' }] });
    expect(merge).toMatchObject({ files: [{ path: 'a.ts', letter: 'A' }] });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'commit', message: 'Fix it' }, merge)).toMatchObject({ choice: 'commit', message: 'Fix it' });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'commit', message: '  ' }, merge)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'commit', message: 'x'.repeat(64 * 1024 + 1) }, merge)).toBeUndefined();
    const review = dialog({ dialog: 'setupReview', projectName: 'alpha', commands: ['npm ci'] });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'setupReview', choice: 'run' }, review)).toMatchObject({ choice: 'run' });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'setupReview', choice: 'run', commands: ['rm -rf /'] }, review)).toBeUndefined();
    const leftovers = dialog({ dialog: 'leftovers', items: [{ path: '/a', reason: 'unregistered' }, { path: '/b', reason: 'gitRecordOnly', repository: '/p' }] });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'prune', path: '/b' }, leftovers)).toMatchObject({ choice: 'prune', path: '/b' });
    // prune only for git's own stale record, and only a listed path
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'prune', path: '/a' }, leftovers)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'reveal', path: '/c' }, leftovers)).toBeUndefined();
    // Reveal only for a folder no record owns; Delete and Keep only for a worktree no chat ever worked in
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'reveal', path: '/b' }, leftovers)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'reveal', path: '/a' }, leftovers)).toMatchObject({ choice: 'reveal', path: '/a' });
    const unused = dialog({ dialog: 'leftovers', items: [{ path: '/n', reason: 'noChat' }, { path: '/a', reason: 'unregistered' }] });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'delete', path: '/n' }, unused)).toMatchObject({ choice: 'delete', path: '/n' });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'keep', path: '/n' }, unused)).toMatchObject({ choice: 'keep', path: '/n' });
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'delete', path: '/a' }, unused)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'reveal', path: '/n' }, unused)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, leftovers)).toEqual({ kind: 'dismissed' });
  });

  it('shows git and disk text with its control and bidi characters visible, keeps each file\'s status letter, and cuts the lists to bounds', () => {
    const bounded = dialog({ dialog: 'refusal', action: 'apply', files: [{ path: 'a\u202Eb.ts', letter: 'M' }, ...Array.from({ length: 300 }, (_, index) => ({ path: `f${index}`, letter: 'U' as const }))] });
    expect(bounded.dialog === 'refusal' && bounded.files.length).toBe(200);
    expect(bounded.dialog === 'refusal' && bounded.files[0]!.path).not.toContain('\u202E');
    expect(bounded.dialog === 'refusal' && bounded.files[0]!.letter).toBe('M');
    const handOff = dialog({ dialog: 'handOffConfirm', direction: 'toWorktree', files: [{ path: 'x.ts', letter: 'D', alsoUserEdits: true }] });
    expect(handOff).toMatchObject({ files: [{ path: 'x.ts', letter: 'D', alsoUserEdits: true }] });
  });

  it('asks through the message dialog when the overlay cannot, and a dismissed dialog answers its cancel choice', async () => {
    const asked: unknown[] = [];
    const warnings: string[] = [];
    const ask = createWorktreeDialogAsker({
      overlay: () => ({ request: () => Promise.reject(new Error('gone')) }),
      focused: () => undefined,
      ask: async (question) => {
        asked.push(question);
        return 0;
      },
      warn: (message) => warnings.push(message),
      t: (message, ...args) => message.replace(/\{(\d)\}/g, (_, index: string) => String(args[Number(index)])),
      log: () => undefined,
    });
    expect(await ask({ dialog: 'rewritten', branch: 'main' })).toEqual({ dialog: 'rewritten', choice: 'rebase' });
    expect(asked[0]).toMatchObject({ message: 'main was rewritten after this worktree started', actions: ['Rebase onto main', 'Apply instead'] });
    // a commit message needs the overlay's text box: no message dialog asks it, and the user is told the merge did not run
    expect(await ask({ dialog: 'mergeMessage', branch: 'b', target: 'main', files: [] })).toEqual({ dialog: 'mergeMessage', choice: 'cancel', message: '' });
    expect(warnings).toEqual(['The merge needs its commit message dialog, which could not be shown, so nothing was merged.']);
    const dismissed = createWorktreeDialogAsker({ overlay: () => ({ request: async () => ({ kind: 'dismissed' }) }), focused: () => undefined, ask: async () => 0, warn: () => undefined, t: (message) => message, log: () => undefined });
    expect(await dismissed({ dialog: 'setupReview', projectName: 'p', commands: ['npm ci'] })).toEqual({ dialog: 'setupReview', choice: 'skip' });
    expect(cancelAnswer({ dialog: 'delete', path: '/w', branch: 'b', uncommitted: [], submoduleChanges: [], unmergedCommits: [], deleteBranchDefault: true, deleteBranchLocked: false })).toEqual({ dialog: 'delete', choice: 'cancel', deleteBranch: true });
  });
});

describe('trust of chat worktrees (rule 8)', () => {
  let userData: string | undefined;
  afterEach(() => {
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  });

  it('answers for a live chat worktree with its project\'s trust, names its working folders in a grant, and asks for the project', async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-wt-trust-'));
    const project = path.join(userData, 'project');
    const worktree = path.join(userData, 'worktrees', 'abcd1234');
    const questions: string[] = [];
    const store = new TrustStore(userData, async (question) => {
      questions.push(question.message);
      return 0;
    }, (message, ...args) => message.replace('{0}', args[0] ?? ''), () => undefined);
    store.setWorktrees({ projectOf: (folder) => (folder === worktree ? project : undefined), workingFolders: (projectPath) => (projectPath === project ? [worktree] : []) });
    const granted: Array<readonly string[]> = [];
    store.onDidGrant((folders) => granted.push(folders));
    expect(store.isTrusted(worktree)).toBe(false);
    expect(await store.requestTrust(worktree)).toBe(true);
    expect(questions).toEqual([`Do you trust the authors of the files in ${project}?`]);
    expect(granted).toEqual([[project, worktree]]);
    expect(store.isTrusted(worktree)).toBe(true);
    // a folder no live chat record names never inherits
    expect(store.isTrusted(path.join(userData, 'worktrees', 'adopted1'))).toBe(false);
  });
});
