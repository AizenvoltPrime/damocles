import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type ChatEntry, type FolderTargetEntry } from '../../../core-protocol';
import { CoreClient } from '../../core-client';
import { authorityProjectKeys, ForeignProjectKeyError, LOCAL_PROJECT_KEYS } from '../remote-project-keys';

const NATIVE = '/srv/app';
const SHELL = `loopback|${NATIVE}`;
const target: FolderTargetEntry = { key: NATIVE, fsPath: NATIVE, name: 'app', label: 'app', projectScope: true };
const owned: FolderTargetEntry = { key: '/srv/app-wt', fsPath: '/srv/app-wt', name: 'app-wt', label: 'app', projectScope: true, ownerKey: NATIVE };
const chat: ChatEntry = {
  panelId: 'p1',
  viewId: 'v1',
  hasConversation: false,
  folder: owned,
  permissions: { permissionMode: 'default', dangerouslySkipPermissions: false },
};

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function connect(): { client: CoreClient; core: ReturnType<typeof createCoreEndpoint>; foreign: ReturnType<typeof vi.fn> } {
  const { main, core } = createLoopback();
  const mainEnd = createMainEndpoint(main, () => undefined);
  const coreEnd = createCoreEndpoint(core, () => undefined);
  const foreign = vi.fn();
  const client = new CoreClient(mainEnd, (_view, attach) => attach(), authorityProjectKeys('loopback', foreign));
  closers.push(() => {
    client.dispose();
    mainEnd.close('closed');
    coreEnd.close('closed');
  });
  return { client, core: coreEnd, foreign };
}

describe('remote project keys', () => {
  it('prefixes the folder targets and the chats mirror toward the shell', () => {
    const { client, core } = connect();
    core.publish('folderTargets', { defaultKey: NATIVE, targets: [target, owned] });
    core.publish('chats', { panelId: 'p1', entry: chat });
    expect(client.defaultTarget()?.key).toBe(SHELL);
    expect(client.resolve('loopback|/srv/app-wt')?.ownerKey).toBe(SHELL);
    expect(client.projectOf('loopback|/srv/app-wt')?.key).toBe(SHELL);
    expect(client.chat('p1')?.folder).toEqual({ ...owned, key: 'loopback|/srv/app-wt', ownerKey: SHELL });
  });

  it('strips the prefix from catalog.list and prefixes its rows', async () => {
    const { client, core } = connect();
    const asked = vi.fn();
    core.serve('catalog.list', ({ projectKey }) => {
      asked(projectKey);
      return [{ id: 's1', timestamp: 1, workspaceFolder: { key: NATIVE, label: 'app' }, listedFrom: '/srv/app-wt' }];
    });
    const rows = await client.listSessions(SHELL);
    expect(asked).toHaveBeenCalledWith(NATIVE);
    expect(rows[0]).toMatchObject({ workspaceFolder: { key: SHELL }, listedFrom: 'loopback|/srv/app-wt' });
  });

  it('strips the prefix from chats.projectBusy, scm.ignoredIn and mention targets', async () => {
    const { client, core } = connect();
    const seen: unknown[] = [];
    core.serve('chats.projectBusy', ({ projectKey }) => {
      seen.push(projectKey);
      return false;
    });
    core.serve('scm.ignoredIn', ({ projectKey }) => {
      seen.push(projectKey);
      return [];
    });
    core.serve('chats.mention', ({ target: mentioned }) => {
      seen.push(mentioned);
    });
    await client.projectBusy(SHELL);
    await client.scmIgnoredIn(SHELL, '', []);
    await client.mention('p1', { projectKey: SHELL, relativePath: 'a.ts' });
    expect(seen).toEqual([NATIVE, NATIVE, { projectKey: NATIVE, relativePath: 'a.ts' }]);
  });

  it('prefixes the scm mirror\'s view, repository and decorations keys and the catalog and scm events', () => {
    const { client, core } = connect();
    const patches: unknown[] = [];
    const events: unknown[] = [];
    const catalog: unknown[] = [];
    client.onScmMirror((patch) => patches.push(patch));
    client.onScmChanged((event) => events.push(event));
    client.onCatalogChanged((key) => catalog.push(key));
    core.publish('scm', { kind: 'view', projectKey: NATIVE, view: { projectKey: NATIVE, repos: [] } });
    core.publish('scm', { kind: 'repository', repoId: 'r1', repository: { projectKey: NATIVE, projectPath: NATIVE, kind: 'root', root: NATIVE, gitDir: '.git', commonDir: '.git', snapshot: { repoId: 'r1', projectKey: NATIVE } } });
    core.publish('scm', { kind: 'decorations', projectKey: NATIVE, files: {} });
    core.emit('scm.changed', { event: { kind: 'view', projectKey: NATIVE } });
    core.emit('catalog.changed', { projectKey: NATIVE });
    expect(patches).toEqual([
      { kind: 'view', projectKey: SHELL, view: { projectKey: SHELL, repos: [] } },
      { kind: 'repository', repoId: 'r1', repository: { projectKey: SHELL, projectPath: NATIVE, kind: 'root', root: NATIVE, gitDir: '.git', commonDir: '.git', snapshot: { repoId: 'r1', projectKey: SHELL } } },
      { kind: 'decorations', projectKey: SHELL, files: {} },
    ]);
    expect(events).toEqual([{ kind: 'view', projectKey: SHELL }]);
    expect(catalog).toEqual([SHELL]);
  });

  it('refuses a key of another authority toward core, and a prefixed key core sends', async () => {
    const { client, core, foreign } = connect();
    await expect(client.projectBusy('ssh+h1|/srv/app')).rejects.toThrow(ForeignProjectKeyError);
    await expect(client.listSessions('/srv/app')).rejects.toThrow(ForeignProjectKeyError);
    await expect(client.mention('p1', { path: '/home/me/notes.md' })).rejects.toThrow(ForeignProjectKeyError);
    core.publish('folderTargets', { defaultKey: 'ssh+h1|/srv/app', targets: [] });
    expect(foreign).toHaveBeenCalledTimes(1);
    expect(client.defaultTarget()).toBeUndefined();
  });

  it('refuses an empty or relative native key both ways, which would read back as a local key', async () => {
    const { client, core, foreign } = connect();
    const keys = authorityProjectKeys('loopback', () => undefined);
    for (const key of ['', 'srv/app', 'C:app']) {
      expect(() => keys.toShell(key)).toThrow(ForeignProjectKeyError);
      expect(() => keys.toCore(`loopback|${key}`)).toThrow(ForeignProjectKeyError);
    }
    core.publish('folderTargets', { defaultKey: 'srv/app', targets: [] });
    expect(foreign).toHaveBeenCalledTimes(1);
    await expect(client.projectBusy('loopback|')).rejects.toThrow(ForeignProjectKeyError);
  });

  it('keeps local keys as they are and refuses a remote key on the local core', () => {
    expect(LOCAL_PROJECT_KEYS.toShell('/projects/a')).toBe('/projects/a');
    expect(LOCAL_PROJECT_KEYS.toCore('c:\\projects\\a')).toBe('c:\\projects\\a');
    expect(() => LOCAL_PROJECT_KEYS.toCore(SHELL)).toThrow(ForeignProjectKeyError);
    expect(() => LOCAL_PROJECT_KEYS.toShell(SHELL)).toThrow(ForeignProjectKeyError);
  });
});
