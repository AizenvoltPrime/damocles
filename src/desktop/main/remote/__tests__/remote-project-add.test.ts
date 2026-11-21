import { describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../../../../platform/disposable';
import type { LocateOutcome } from '../../locate-project';
import type { MissingProject } from '../../project-readd';
import type { TrustAnswer } from '../../trust-store';
import { addRemoteProjectAt, type RemoteProjectAddDeps } from '../remote-project-add';
import { remoteHostTrust } from '../remote-trust';
import { TrustPending } from '../trust-pending';

const AUTHORITY = 'ssh+h1';
const FOLDER = '/srv/clones/acme';
const KEY = `${AUTHORITY}|${FOLDER}`;
const ACME: MissingProject = { key: `${AUTHORITY}|/srv/acme`, name: 'acme', fsPath: '/srv/acme', chats: 2 };

interface World {
  // granted: the question this flow asked made the grant, so its answer has an undo
  trust: 'granted' | 'trusted' | 'declined';
  listed: boolean;
  missing: MissingProject | undefined;
  moved: LocateOutcome;
  failAt: 'hold' | 'missing' | 'add' | 'added' | 'move' | undefined;
}

/**
 * The flow over this computer's trust mirror for the host: the host store's grants (a set), the listed projects and the folders
 * trustPending holds, as main's remoteHostTrust builds it; `published` is what the host's core received, in order.
 */
function setup(world: Partial<World> = {}) {
  const w: World = { trust: 'granted', listed: false, missing: undefined, moved: { kind: 'started', id: 'r1' }, failAt: undefined, ...world };
  const trail: string[] = [];
  const storeTrust = new Set<string>();
  const storeListeners = new Set<() => void>();
  const projects: string[] = [];
  const folderListeners = new Set<() => void>();
  const pending = new TrustPending(() => {
    for (const listener of [...folderListeners]) listener();
  });
  const changedStore = (): void => {
    for (const listener of [...storeListeners]) listener();
  };
  const listen = (listeners: Set<() => void>, listener: () => void): Disposable => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  };
  const mirror = remoteHostTrust({
    authorityKey: AUTHORITY,
    store: { isTrusted: (_authority, folderKey) => storeTrust.has(folderKey), onDidChange: (listener) => listen(storeListeners, listener) },
    folders: () => [...projects.map((folder) => ({ folderKey: folder, fsPath: folder })), ...pending.folders(AUTHORITY)],
    onDidChangeFolders: (listener) => listen(folderListeners, listener),
    requestTrust: async () => false,
  });
  const published: string[] = [];
  // the trail when each work the quit joined started and when it settled
  const joined: Array<{ from: string[]; to?: string[] }> = [];
  mirror.onDidChange(({ granted, revoked }) => {
    if (granted.length > 0) published.push(`grant:${granted.join(',')}`);
    if (revoked.length > 0) published.push(`revoke:${revoked.join(',')}`);
  });
  const deps: RemoteProjectAddDeps = {
    opening: {
      isDirectory: async () => true,
      projectKeyOf: async (authority, folder) => `${authority}|${folder}`,
      isProject: () => w.listed,
      notFolder: (authority, folder) => new Error(`${folder} is no folder on ${authority}`),
      add: async (_authority, folder) => {
        trail.push('add');
        if (w.failAt === 'add') throw new Error('remote-hosts.json is read-only');
        projects.push(folder);
        changedStore();
      },
      added: () => {
        trail.push('added');
        if (w.failAt === 'added') throw new Error('the session mirror could not sync');
      },
      select: async (key) => { trail.push(`select:${key}`); },
    },
    askTrust: async (projectKey, folder): Promise<TrustAnswer> => {
      trail.push(`trust:${projectKey}`);
      if (w.trust === 'declined') return { trusted: false };
      storeTrust.add(folder);
      changedStore();
      if (w.trust === 'trusted') return { trusted: true };
      return {
        trusted: true,
        undo: async () => {
          trail.push('undo');
          storeTrust.delete(folder);
          changedStore();
        },
      };
    },
    holdTrust: (_projectKey, folder) => {
      trail.push('hold');
      if (w.failAt === 'hold') throw new Error('the trust mirror is gone');
      return pending.hold(AUTHORITY, { folderKey: folder, fsPath: folder });
    },
    missingProjectOf: async (folder) => {
      // what the host's core reads as trusted when projects.movedFrom runs there
      trail.push(`movedFrom:${folder} mirror:${mirror.trustedKeys().join(',')} published:${published.join(',')}`);
      if (w.failAt === 'missing') throw new Error('the host\'s core restarted');
      return w.missing;
    },
    moveChats: async (key) => {
      trail.push(`move:${key} mirror:${mirror.trustedKeys().join(',')}`);
      if (w.failAt === 'move') throw new Error('Locate failed');
      return w.moved;
    },
    joinQuit: (work) => {
      const join: { from: string[]; to?: string[] } = { from: [...trail] };
      joined.push(join);
      // registered ahead of the caller's own await, so the snapshot holds nothing that follows the work
      const settle = (): void => { join.to = [...trail]; };
      void work.then(settle, settle);
      return work;
    },
  };
  return { w, deps, trail, pending, published, mirror, joined };
}

describe('addRemoteProjectAt', () => {
  // the host's core reads a folder's root commits only once its own trust mirror lists it
  it('asks trust, then lists the folder in the host\'s trust mirror before projects.movedFrom runs there, adds and selects it', async () => {
    const { deps, trail, pending, published } = setup();
    expect(await addRemoteProjectAt(deps, AUTHORITY, FOLDER)).toBe(KEY);
    expect(trail).toEqual([`trust:${KEY}`, 'hold', `movedFrom:${FOLDER} mirror:${FOLDER} published:grant:${FOLDER}`, 'add', 'added', `select:${KEY}`]);
    expect(pending.folders(AUTHORITY)).toEqual([]);
    // the listed project holds the folder once trustPending lets go
    expect(published).toEqual([`grant:${FOLDER}`]);
  });

  it('holds a quit\'s store flush from the trust question until the folder is listed, or a failed add took the grant back', async () => {
    const added = setup();
    await addRemoteProjectAt(added.deps, AUTHORITY, FOLDER);
    expect(added.joined).toEqual([{ from: [`trust:${KEY}`], to: [`trust:${KEY}`, 'hold', `movedFrom:${FOLDER} mirror:${FOLDER} published:grant:${FOLDER}`, 'add'] }]);
    const failed = setup({ failAt: 'add' });
    await expect(addRemoteProjectAt(failed.deps, AUTHORITY, FOLDER)).rejects.toThrow('remote-hosts.json is read-only');
    expect(failed.joined.map((join) => join.to?.slice(-2))).toEqual([['add', 'undo']]);
  });

  it('selects a folder that is a project already, asking nothing', async () => {
    const { deps, trail } = setup({ listed: true });
    expect(await addRemoteProjectAt(deps, AUTHORITY, FOLDER)).toBe(KEY);
    expect(trail).toEqual([`select:${KEY}`]);
  });

  it('refuses a path that is no folder on the host before asking trust', async () => {
    const { deps, trail } = setup();
    const missing: RemoteProjectAddDeps = { ...deps, opening: { ...deps.opening, isDirectory: async () => false } };
    await expect(addRemoteProjectAt(missing, AUTHORITY, FOLDER)).rejects.toThrow(`${FOLDER} is no folder on ${AUTHORITY}`);
    expect(trail).toEqual([]);
  });

  it('adds the folder and moves the chats the user chose to it, the folder listed while Locate runs', async () => {
    const { deps, trail, pending } = setup({ missing: ACME });
    expect(await addRemoteProjectAt(deps, AUTHORITY, FOLDER)).toBe(KEY);
    expect(trail.slice(-3)).toEqual(['add', 'added', `move:${ACME.key} mirror:${FOLDER}`]);
    expect(pending.folders(AUTHORITY)).toEqual([]);
  });

  it('selects the added folder when the move is cancelled, keeping its trust', async () => {
    const { deps, trail, pending, mirror } = setup({ missing: ACME, moved: { kind: 'cancelled' } });
    await addRemoteProjectAt(deps, AUTHORITY, FOLDER);
    expect(trail.slice(-2)).toEqual([`move:${ACME.key} mirror:${FOLDER}`, `select:${KEY}`]);
    expect(trail).not.toContain('undo');
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(mirror.trustedKeys()).toEqual([FOLDER]);
  });

  it.each(['missing', 'add'] as const)('takes back its own grant and empties trustPending when %s throws before the folder is listed', async (failAt) => {
    const { deps, trail, pending, published, mirror } = setup({ failAt });
    await expect(addRemoteProjectAt(deps, AUTHORITY, FOLDER)).rejects.toThrow();
    expect(trail.at(-1)).toBe('undo');
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(mirror.trustedKeys()).toEqual([]);
    expect(published).toEqual([`grant:${FOLDER}`, `revoke:${FOLDER}`]);
  });

  it('takes back its own grant when the trust hold throws', async () => {
    const { deps, trail, mirror } = setup({ failAt: 'hold' });
    await expect(addRemoteProjectAt(deps, AUTHORITY, FOLDER)).rejects.toThrow('the trust mirror is gone');
    expect(trail).toEqual([`trust:${KEY}`, 'hold', 'undo']);
    expect(mirror.trustedKeys()).toEqual([]);
  });

  it('keeps the listed folder\'s trust when the session mirror sync after the add throws', async () => {
    const { deps, trail, pending, mirror } = setup({ failAt: 'added' });
    await expect(addRemoteProjectAt(deps, AUTHORITY, FOLDER)).rejects.toThrow('the session mirror could not sync');
    expect(trail).not.toContain('undo');
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(mirror.trustedKeys()).toEqual([FOLDER]);
  });

  it('empties trustPending when the move throws after the add, keeping the listed folder\'s trust', async () => {
    const { deps, trail, pending, mirror } = setup({ missing: ACME, failAt: 'move' });
    await expect(addRemoteProjectAt(deps, AUTHORITY, FOLDER)).rejects.toThrow('Locate failed');
    expect(trail).not.toContain('undo');
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(mirror.trustedKeys()).toEqual([FOLDER]);
  });

  it.each(['trusted', 'declined'] as const)('revokes nothing on a failure when the answer has no undo (%s)', async (trust) => {
    const { deps, trail, pending } = setup({ trust, failAt: 'add' });
    await expect(addRemoteProjectAt(deps, AUTHORITY, FOLDER)).rejects.toThrow('remote-hosts.json is read-only');
    expect(trail).not.toContain('undo');
    expect(pending.folders(AUTHORITY)).toEqual([]);
  });

  it('still adds a folder whose trust was declined, which the mirror never lists, and still offers what the host matched by remotes', async () => {
    const { deps, trail, pending, published } = setup({ trust: 'declined', missing: ACME });
    expect(await addRemoteProjectAt(deps, AUTHORITY, FOLDER)).toBe(KEY);
    expect(trail).toEqual([`trust:${KEY}`, 'hold', `movedFrom:${FOLDER} mirror: published:`, 'add', 'added', `move:${ACME.key} mirror:`]);
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe('TrustPending', () => {
  it('lists a folder per authority while any hold of it lasts; a release counts once and fires a change each time', () => {
    const changed = vi.fn();
    const pending = new TrustPending(changed);
    const folder = { folderKey: '/srv/a', fsPath: '/srv/a' };
    const first = pending.hold(AUTHORITY, folder);
    const second = pending.hold(AUTHORITY, folder);
    expect(pending.folders('wsl+other')).toEqual([]);
    first();
    first();
    expect(pending.folders(AUTHORITY)).toEqual([folder]);
    second();
    expect(pending.folders(AUTHORITY)).toEqual([]);
    expect(changed.mock.calls).toEqual([[AUTHORITY], [AUTHORITY], [AUTHORITY], [AUTHORITY]]);
  });
});
