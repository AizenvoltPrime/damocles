import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { TrustChange } from '../../../platform/trust-service';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { worktreeFolderFor } from '../../../core/worktrees/records';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../../../core/worktrees/registry';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type CoreInit } from '../../core-protocol';
import { createTrustMirror, type TrustMirror } from '../platform/mirrored';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

let base: string;
let root: string;
let project: string;
let untrustedProject: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-trust-mirror-')));
  root = path.join(base, 'worktrees');
  project = path.join(base, 'project');
  untrustedProject = path.join(base, 'other');
});
afterEach(() => {
  for (const disposable of opened.splice(0)) disposable.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function registry(): WorktreeRegistry {
  const r = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined });
  opened.push(r);
  return r;
}

function chat(id: string, projectPath = project): Omit<ChatWorktreeRecord, 'index'> {
  const worktreeRoot = worktreeFolderFor(root, projectPath, id);
  return { id, kind: 'chat', projectPath, repositoryRoot: projectPath, worktreeRoot, workingFolder: worktreeRoot, branch: `damocles/${id}`, baseCommit: 'a'.repeat(40), createdAt: 1 };
}

function mirror(trustedKeys: readonly string[]): { trust: TrustMirror; changes: TrustChange[]; publish: (keys: readonly string[], change: TrustChange) => void } {
  const loop = createLoopback();
  const main = createMainEndpoint(loop.main, () => undefined);
  const core = createCoreEndpoint(loop.core, () => undefined);
  const trust = createTrustMirror(core, { mirrors: { trust: { keys: trustedKeys } } } as unknown as CoreInit);
  opened.push(trust);
  const changes: TrustChange[] = [];
  trust.onDidChangeTrust((change) => changes.push(change));
  return { trust, changes, publish: (keys, change) => main.publish('trust', { keys: [...keys], granted: [...change.granted], revoked: [...change.revoked] }) };
}

describe('the trust mirror follows the worktree registry', () => {
  it('fires a change naming a working folder whose answer a registry change moved, and none for a change that moves no answer', async () => {
    const { trust, changes } = mirror([folderKey(project)]);
    const ours = registry();
    let registryChanges = 0;
    ours.onDidChange(() => registryChanges++);
    trust.followRegistry(ours);
    expect(changes).toEqual([]);

    const live = await ours.addChat(chat('aaaaaaaa'));
    expect(trust.isTrusted(live.workingFolder)).toBe(true);
    expect(changes).toEqual([{ granted: [live.workingFolder], revoked: [] }]);

    // the registry changes, no answer does: a record marked used, a record of an untrusted project
    changes.length = 0;
    registryChanges = 0;
    await ours.markUsed(live.id, 5);
    const other = await ours.addChat(chat('bbbbbbbb', untrustedProject));
    expect(registryChanges).toBe(2);
    expect(trust.isTrusted(other.workingFolder)).toBe(false);
    expect(changes).toEqual([]);

    // another process deletes the record; this one reads the file again
    await registry().markDeleted(live.id, 9);
    ours.reload();
    expect(trust.isTrusted(live.workingFolder)).toBe(false);
    expect(changes).toEqual([{ granted: [], revoked: [live.workingFolder] }]);
  });

  it('answers for the working folders a registry already holds once it follows it, and names them in a patch that moves their project', async () => {
    const ours = registry();
    const live = await ours.addChat(chat('aaaaaaaa'));
    const { trust, changes, publish } = mirror([folderKey(project)]);
    expect(trust.isTrusted(live.workingFolder)).toBe(false);
    trust.followRegistry(ours);
    expect(trust.isTrusted(live.workingFolder)).toBe(true);
    expect(changes).toEqual([{ granted: [live.workingFolder], revoked: [] }]);

    changes.length = 0;
    publish([], { granted: [], revoked: [project] });
    await expect.poll(() => changes).toEqual([{ granted: [], revoked: [project, live.workingFolder] }]);
    expect(trust.isTrusted(live.workingFolder)).toBe(false);
  });
});
