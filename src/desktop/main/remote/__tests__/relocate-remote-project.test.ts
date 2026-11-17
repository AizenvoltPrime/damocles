import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RelocationView } from '../../../../core/project-relocation/types';
import { RelocatedProjects } from '../../relocate-project-state';
import { HostStore } from '../host-store';
import { remoteRelocation } from '../relocate-remote-project';
import { projectMirrorFolder, SessionMirror } from '../session-mirror';

const AUTHORITY = 'ssh+prod';
const key = (folder: string): string => `${AUTHORITY}|${folder}`;
const project = (folder: string) => ({ path: folder, folderKey: folder, os: 'linux' as const });
// this run's Locate asked for it
const LOCATED = { answers: new Map<string, string>() };
const view: RelocationView = {
  id: 'r1', seq: 1, requestedBy: 'daemon', mode: 'locate', from: '/srv/old', to: '/srv/new', state: 'coreDone', startedAt: 1_000, step: 'hostState', progress: { done: 1, total: 1 }, chats: 1,
};

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-relocation-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

async function setup(hostId: string | undefined, options: { readonly reopen?: boolean; readonly mirrorFailsOnce?: boolean } = {}) {
  const store = await HostStore.open(userData, () => undefined);
  if (!options.reopen) {
    await store.addProject(AUTHORITY, project('/srv/a'), key('/srv/a'), () => []);
    await store.addProject(AUTHORITY, project('/srv/old'), key('/srv/old'), () => [key('/srv/a')]);
    await store.grantTrust(AUTHORITY, '/srv/old');
  }
  const root = path.join(userData, 'remote', 'prod', 'mirror');
  const sessions = new SessionMirror({ root, channel: () => { throw new Error('no channel in this test'); }, log: () => undefined });
  let mirrorFails = options.mirrorFailsOnce === true;
  const mirror: Pick<SessionMirror, 'relocateProject'> = {
    relocateProject: async (from, to) => {
      if (!mirrorFails) return sessions.relocateProject(from, to);
      mirrorFails = false;
      throw new Error('the mirror rename failed');
    },
  };
  const oldMirror = projectMirrorFolder(root, '/srv/old');
  if (!options.reopen) {
    fs.mkdirSync(oldMirror, { recursive: true });
    fs.writeFileSync(path.join(oldMirror, 's1.jsonl'), 'chat\n');
  }
  // what this computer's core holds: forge bindings by project key, host aliases appended once per move
  const bindings = new Map([[key('/srv/old'), 'account-1']]);
  const aliases: Array<{ hostId: string; from: string; to: string }> = [];
  const trail: string[] = [];
  const steps = remoteRelocation({
    authority: { kind: 'ssh', hostId: 'prod' },
    authorityKey: AUTHORITY,
    hostId,
    os: 'linux',
    store,
    mirror: () => mirror,
    relocateBindings: async (fromKey, toKey) => {
      const bound = bindings.get(fromKey);
      if (bound === undefined) return;
      bindings.delete(fromKey);
      if (!bindings.has(toKey)) bindings.set(toKey, bound);
    },
    addHostAlias: async (alias) => {
      if (!aliases.some((known) => known.hostId === alias.hostId && known.from === alias.from && known.to === alias.to)) aliases.push(alias);
    },
  });
  const projects = new RelocatedProjects({
    ...steps,
    listed: (projectKey) => (store.projects().some((entry) => key(entry.project.folderKey) === projectKey) ? { name: 'old' } : undefined),
    // the host reads every listed folder but /srv/a missing
    absent: (projectKey) => projectKey !== key('/srv/a'),
    offerOpen: async () => true,
    askClose: async () => new Map(),
    isTrusted: () => true,
    requestTrust: async () => true,
    savedTabs: () => [],
    relocateStores: async (from, to) => { trail.push(`stores:${from.key}->${to.key}`); },
    relocateWorktreeStores: () => undefined,
    revokeTrust: async () => undefined,
    relocateRoot: () => undefined,
    reopenTabs: async () => undefined,
    closeOldRoot: () => undefined,
    reopenChats: () => undefined,
    select: async (projectKey) => { trail.push(`select:${projectKey}`); },
    announce: (message) => { trail.push(message); },
    describe: () => '',
    report: (action) => { trail.push(`report:${action}`); },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? ''),
  });
  return { store, root, bindings, aliases, trail, projects };
}

describe('the host part of a remote project\'s relocation', () => {
  it('moves the list entry in its slot, revokes the old trust, re-keys the bindings, renames the mirror and records the host alias', async () => {
    const { store, root, bindings, aliases, trail, projects } = await setup('prod');
    await projects.reached(view, LOCATED);
    expect(store.projects().map((entry) => entry.project.path)).toEqual(['/srv/a', '/srv/new']);
    expect(store.order([key('/srv/new'), key('/srv/a')])).toEqual([key('/srv/a'), key('/srv/new')]);
    expect(store.isTrusted(AUTHORITY, '/srv/old')).toBe(false);
    expect([...bindings]).toEqual([[key('/srv/new'), 'account-1']]);
    expect(fs.existsSync(projectMirrorFolder(root, '/srv/old'))).toBe(false);
    expect(fs.readdirSync(projectMirrorFolder(root, '/srv/new'))).toEqual(['s1.jsonl']);
    expect(aliases).toEqual([{ hostId: 'prod', from: '/srv/old', to: '/srv/new', startedAt: 1_000 }]);
    expect(trail).toEqual([`stores:${key('/srv/old')}->${key('/srv/new')}`, `select:${key('/srv/new')}`, 'Moved 1 chat of old to /srv/new.']);
  });

  it('changes nothing more when the mirror reports the relocation again, and its steps run again idempotently', async () => {
    const { store, root, bindings, aliases, trail, projects } = await setup('prod');
    await projects.reached(view, LOCATED);
    const file = fs.readFileSync(store.filePath, 'utf8');
    trail.length = 0;
    await projects.reached(view, LOCATED);
    expect(trail).toEqual([]);
    // a host part cut short after the list moved runs each step again: none of them changes anything
    const steps = remoteRelocation({ authority: { kind: 'ssh', hostId: 'prod' }, authorityKey: AUTHORITY, hostId: 'prod', os: 'linux', store, mirror: () => new SessionMirror({ root, channel: () => { throw new Error('none'); }, log: () => undefined }), relocateBindings: async () => undefined, addHostAlias: async () => undefined });
    const from = { key: key('/srv/old'), fsPath: '/srv/old' };
    const to = { key: key('/srv/new'), fsPath: '/srv/new' };
    await steps.applyHostState(view, from, to);
    await steps.relocateList(from, to, view.id);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(file);
    expect(fs.readdirSync(projectMirrorFolder(root, '/srv/new'))).toEqual(['s1.jsonl']);
    expect([...bindings]).toEqual([[key('/srv/new'), 'account-1']]);
    expect(aliases).toHaveLength(1);
  });

  it('keeps no mirror and records no host alias for an authority without a host id', async () => {
    const { root, aliases, projects } = await setup(undefined);
    await projects.reached(view, LOCATED);
    expect(aliases).toEqual([]);
    expect(fs.existsSync(projectMirrorFolder(root, '/srv/old'))).toBe(true);
  });

  it('runs again whole after a step before the list failed, and then moves the list', async () => {
    const { store, root, bindings, aliases, trail, projects } = await setup('prod', { mirrorFailsOnce: true });
    await expect(projects.reached(view, LOCATED)).rejects.toThrow('the mirror rename failed');
    expect(store.projects().map((entry) => entry.project.path)).toEqual(['/srv/a', '/srv/old']);
    expect(store.relocated(AUTHORITY, view.id)).toBe(false);
    expect(fs.existsSync(projectMirrorFolder(root, '/srv/old'))).toBe(true);
    trail.length = 0;
    await projects.reached(view, LOCATED);
    expect(store.projects().map((entry) => entry.project.path)).toEqual(['/srv/a', '/srv/new']);
    expect(store.relocated(AUTHORITY, view.id)).toBe(true);
    expect(fs.readdirSync(projectMirrorFolder(root, '/srv/new'))).toEqual(['s1.jsonl']);
    expect([...bindings]).toEqual([[key('/srv/new'), 'account-1']]);
    expect(aliases).toEqual([{ hostId: 'prod', from: '/srv/old', to: '/srv/new', startedAt: 1_000 }]);
    expect(trail).toEqual([`stores:${key('/srv/old')}->${key('/srv/new')}`, `select:${key('/srv/new')}`, 'Moved 1 chat of old to /srv/new.']);
  });

  it('never applies a relocation again after a relaunch, to a folder added again at the old path that the host reads missing', async () => {
    const first = await setup('prod');
    await first.projects.reached(view, LOCATED);
    await first.store.addProject(AUTHORITY, project('/srv/old'), key('/srv/old'), () => [key('/srv/a'), key('/srv/new')]);
    await first.store.grantTrust(AUTHORITY, '/srv/old');
    const relaunched = await setup('prod', { reopen: true });
    await relaunched.projects.reached(view, 'other');
    await relaunched.projects.reached(view, LOCATED);
    expect(relaunched.trail).toEqual([]);
    expect(relaunched.store.projects().map((entry) => entry.project.path)).toEqual(['/srv/a', '/srv/new', '/srv/old']);
    expect(relaunched.store.isTrusted(AUTHORITY, '/srv/old')).toBe(true);
  });
});
