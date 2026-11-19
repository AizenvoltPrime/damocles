import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderTargetEntry } from '../../core-protocol';
import type { WorktreeRecord } from '../../../core/worktrees/registry';
import { chatProjectKey, keptRemoteChatProjectKey, savedChatProjectKey, type SavedChatProjectDeps } from '../chat-project';

const target = (key: string, ownerKey?: string): FolderTargetEntry => ({
  key,
  fsPath: path.resolve(`/projects/${key}`),
  name: key,
  label: key,
  projectScope: true,
  ...(ownerKey !== undefined ? { ownerKey } : {}),
});

// What core last reported: projects alpha and v, and the working folders w and u of alpha's chats; alpha is the default. u is
// open as a project in main's list already, which core has not reported yet.
const projects = new Map([['alpha', target('alpha')], ['v', target('v')]]);
const owned = new Map([['w', target('w', 'alpha')], ['u', target('u', 'alpha')]]);
const client = {
  project: (key: string) => projects.get(key),
  projectOf: (key: string) => projects.get(key) ?? projects.get(owned.get(key)?.ownerKey ?? ''),
  defaultTarget: () => projects.get('alpha'),
};
const listed = (key: string): boolean => ['alpha', 'plain', 'v', 'u'].includes(key);

describe('chatProjectKey', () => {
  it("names the project core reports for a bare folder key, a worktree's own project included", () => {
    expect(chatProjectKey('alpha', client, listed)).toBe('alpha');
    expect(chatProjectKey('w', client, listed)).toBe('alpha');
  });

  // docs/invariants.md "Worktree chats", Ownership: v and u, worktrees of alpha, are open as projects too.
  it("names the owner of a chat's working folder whatever else the folder is open as, and the folder for its own chat", () => {
    expect(chatProjectKey({ key: 'v', ownerKey: 'alpha' }, client, listed)).toBe('alpha');
    expect(chatProjectKey({ key: 'v' }, client, listed)).toBe('v');
    // never the owner of a working folder for a chat of the folder as a project, before core reports that project
    expect(chatProjectKey({ key: 'u' }, client, listed)).toBe('u');
  });

  // Main's project list leads core's report of it back; another project's chat would be remembered as this one's.
  it('names a listed project core has not reported yet, not the default target', () => {
    expect(chatProjectKey('plain', client, listed)).toBe('plain');
    expect(chatProjectKey({ key: 'plain' }, client, listed)).toBe('plain');
  });

  it('names the default target for a folder that left the project list', () => {
    expect(chatProjectKey('removed', client, listed)).toBe('alpha');
    expect(chatProjectKey({ key: 'removed' }, client, listed)).toBe('alpha');
  });
});

describe('savedChatProjectKey', () => {
  const chatRecord = (id: string, projectPath: string, workingFolder: string, deletedAt?: number): WorktreeRecord => ({
    kind: 'chat', id, projectPath, workingFolder, worktreeRoot: workingFolder, repositoryRoot: projectPath, branch: `damocles/${id}`, index: 1,
    baseCommit: 'c0ffee', createdAt: 1, ...(deletedAt !== undefined ? { deletedAt } : {}),
  });
  // keys are the folder paths themselves; core has bound no chat yet, so it reports no owner for a working folder
  const deps = (extra: Partial<SavedChatProjectDeps> = {}): SavedChatProjectDeps => ({
    listed: (key) => ['alpha', 'beta', 'wt-open'].includes(key),
    records: [
      chatRecord('w1', 'beta', 'wt-beta'),
      chatRecord('w2', 'alpha', 'wt-gone', 5),
      chatRecord('w3', 'beta', 'wt-gone'),
      chatRecord('w4', 'alpha', 'wt-open'),
    ],
    keyOf: (fsPath) => fsPath,
    movedFrom: () => undefined,
    resolve: (key) => chatProjectKey(key, client, (candidate) => ['alpha', 'beta', 'wt-open'].includes(candidate)) ?? key,
    ...extra,
  });

  it('reopens a chat of a chat worktree in its record\'s project, not the default one', () => {
    expect(savedChatProjectKey('wt-beta', deps())).toBe('beta');
    // a live record of the folder wins over a deleted one
    expect(savedChatProjectKey('wt-gone', deps())).toBe('beta');
    expect(savedChatProjectKey('wt-gone', deps({ records: [chatRecord('w2', 'alpha', 'wt-gone', 5)] }))).toBe('alpha');
  });

  it('keeps a folder listed as a project of its own, and a project folder, as they are', () => {
    expect(savedChatProjectKey('wt-open', deps())).toBe('wt-open');
    expect(savedChatProjectKey('beta', deps())).toBe('beta');
    expect(savedChatProjectKey('removed', deps())).toBe('alpha');
  });

  it('reopens a chat saved under the destination of a move whose host part is pending in the project it left', () => {
    const moved = deps({ movedFrom: (key) => (key === 'beta-moved' ? 'beta' : undefined) });
    expect(savedChatProjectKey('beta-moved', moved)).toBe('beta');
    expect(savedChatProjectKey('beta-moved', deps())).toBe('alpha');
    // a chat worktree of the moved project names the destination as its project once core re-pointed its record
    expect(savedChatProjectKey('wt-moved', { ...moved, records: [chatRecord('w5', 'beta-moved', 'wt-moved')] })).toBe('beta');
  });
});

describe('keptRemoteChatProjectKey', () => {
  const listed = (key: string): boolean => ['host/alpha', 'host/beta'].includes(key);
  const movedFrom = (): string | undefined => undefined;

  it('tracks a kept remote chat under its own listed project, not core\'s default target', () => {
    expect(keptRemoteChatProjectKey({ projectKey: 'host/beta' }, { listed, movedFrom, defaultKey: 'host/alpha' })).toBe('host/beta');
  });

  it('falls back to core\'s default target for a project no longer listed or a record with none', () => {
    expect(keptRemoteChatProjectKey({ projectKey: 'host/gone' }, { listed, movedFrom, defaultKey: 'host/alpha' })).toBe('host/alpha');
    expect(keptRemoteChatProjectKey({}, { listed, movedFrom, defaultKey: 'host/alpha' })).toBe('host/alpha');
  });

  // a reconnect between relocateStores and replaceProject: the record names the destination, the list still the source
  it('tracks a chat whose record a finished move re-keyed under the listed project the move left', () => {
    const moved = (key: string): string | undefined => (key === 'host/beta-moved' ? 'host/beta' : undefined);
    expect(keptRemoteChatProjectKey({ projectKey: 'host/beta-moved' }, { listed, movedFrom: moved, defaultKey: 'host/alpha' })).toBe('host/beta');
    expect(keptRemoteChatProjectKey({ projectKey: 'host/gone' }, { listed, movedFrom: moved, defaultKey: 'host/alpha' })).toBe('host/alpha');
  });
});
