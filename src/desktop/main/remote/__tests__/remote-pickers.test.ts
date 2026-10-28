import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { HostStore } from '../host-store';
import { RemoteConnections } from '../connections';
import { RemoteHosts } from '../remote-hosts';
import { parseSshCommand } from '../ssh';
import { parseConnectRequest, parseOverlayAnswer } from '../../overlay';
import { confineExisting, projectOfPath, type Project } from '../../../local-services/confine';
import { createTreeListing } from '../../../workspace/tree-listing';
import type { RemoteConnection } from '../connection';
import type { ProjectWorkspace } from '../../../workspace/project-workspace';
import type { OverlayAnswer, OverlayRequest, RemoteBrowseResult } from '../../../preload/overlay-channels';

// The "host" is this computer's disk, read through the same confinement a daemon's workspace applies.
let base: string;
let app: Project;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-pickers-')));
  const appPath = path.join(base, 'srv', 'app');
  fs.mkdirSync(path.join(appPath, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'docs', 'plan.md'), '# plan');
  fs.writeFileSync(path.join(appPath, 'docs', 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(appPath, 'README.md'), 'readme');
  outside = path.join(base, 'secret');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keys.md'), 'keys');
  // a folder link inside the project that leads out of it
  fs.symlinkSync(outside, path.join(appPath, 'escape'), 'junction');
  app = { key: 'ssh+h1|app', fsPath: appPath, name: 'app' };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const workspace = {
  files: {
    projectOfPath,
    confineExisting,
    isDirectory: (target: string) => fs.promises.stat(target).then((stat) => stat.isDirectory(), () => false),
  },
  tree: createTreeListing(() => undefined),
} as unknown as ProjectWorkspace;

const facts = { os: process.platform === 'win32' ? 'win32' : 'linux', homedir: os.homedir() } as RemoteConnection['facts'];

type Renderer = (request: Extract<OverlayRequest, { kind: 'connect' }>, browse: (folder?: string) => Promise<RemoteBrowseResult>) => Promise<OverlayAnswer>;

async function setup(renderer: Renderer, roots: () => readonly Project[] = () => [app]) {
  const store = await HostStore.open(path.join(base, 'user-data'), () => undefined);
  const connections = new RemoteConnections({
    host: (id) => store.host(id),
    startSsh: () => new Promise(() => undefined),
    savePlatform: async () => undefined,
    installFolderSettled: async () => undefined,
    connect: () => new Promise(() => undefined),
    connection: () => undefined,
    changed: () => undefined,
    log: () => undefined,
  });
  const logged: string[] = [];
  const requests: OverlayRequest[] = [];
  const addProject = vi.fn(async () => 'key');
  const overlay = {
    request: async (request: OverlayRequest) => {
      requests.push(request);
      if (request.kind !== 'connect' || request.hostId === undefined) return { kind: 'dismissed' as const };
      const hostId = request.hostId;
      const raw = await renderer(request, (folder) => hosts.browse(hostId, folder));
      // main takes only what parseOverlayAnswer accepts for the open request
      return parseOverlayAnswer(raw, request) ?? { kind: 'dismissed' as const };
    },
    send: () => undefined,
    isOpen: () => true,
  };
  const hosts: RemoteHosts = new RemoteHosts({
    store,
    connections,
    update: () => undefined,
    state: () => 'connected',
    connection: () => ({ facts } as RemoteConnection),
    workspace: () => workspace,
    terminals: { canOpen: () => false, open: async () => undefined },
    watchLimit: () => undefined,
    sharedHome: () => undefined,
    projects: () => [],
    pickRoots: roots,
    hostName: () => 'prod-1',
    parse: (input) => parseSshCommand(input),
    sshConfigAliases: async () => [],
    validInstallFolder: () => true,
    addProject,
    showLogs: async () => undefined,
    writeClipboard: () => undefined,
    overlay: () => overlay,
    renamed: () => undefined,
    reconnect: () => undefined,
    latency: () => undefined,
    log: (line) => logged.push(line),
    policyChanged: () => undefined,
    reconnectFresh: async () => undefined,
    deleteRememberedSecrets: async () => undefined,
    forgetLocalData: async () => undefined,
    disconnect: () => undefined,
    openSettings: () => undefined,
    keySetup: { folder: '/nonexistent', clientName: 'laptop', resolveKeygen: async () => undefined, resolveSsh: async () => undefined, run: async () => { throw new Error('no process starts here'); }, sshQuery: async () => { throw new Error('no process starts here'); }, askpass: async () => { throw new Error('no askpass here'); }, sshVersion: async () => undefined, env: {}, log: () => undefined },
    runRemovalStage: async () => { throw new Error('no removal here'); },
    exitControlMaster: async () => undefined,
  });
  return { hosts, requests, logged, addProject };
}

const listed = (result: RemoteBrowseResult): Extract<RemoteBrowseResult, { ok: true }> => {
  if (!result.ok) throw new Error(`browse failed: ${result.error}`);
  return result;
};

describe('a remote core\'s pickers in the host\'s folder browser', () => {
  it('pickFile opens the Connect dialog\'s folder browser in file mode at the default path and answers a confined file', async () => {
    const seen: RemoteBrowseResult[] = [];
    const { hosts, requests } = await setup(async (_request, browse) => {
      seen.push(await browse());
      const docs = listed(await browse(path.join(app.fsPath, 'docs')));
      seen.push(docs);
      return { kind: 'connect', path: path.join(docs.path, 'plan.md') };
    });
    const picked = await hosts.pick('ssh+h1', 'file', { title: 'Select Plan File to Inject', defaultPath: path.join(app.fsPath, 'docs', 'plan.md'), extensions: ['md'] });
    expect(picked).toBe(path.join(app.fsPath, 'docs', 'plan.md'));
    // one browser: the Connect dialog, opened as the picker, never a second kind of popup
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'connect', hostId: 'h1', pick: { mode: 'file', hostName: 'prod-1', roots: [app.fsPath], title: 'Select Plan File to Inject' } });
    expect(parseConnectRequest(requests[0])).toBeDefined();
    // a file default opens at its folder; files are filtered by the extensions, folders listed to walk into
    expect(seen[0]).toMatchObject({ ok: true, path: path.join(app.fsPath, 'docs'), root: app.fsPath, files: ['plan.md'], folders: [] });
    expect(seen[1]).toMatchObject({ parent: app.fsPath });
  });

  it('pickFolder answers a folder, the root included, and lists no files', async () => {
    const answers = [path.join(app.fsPath, 'docs'), app.fsPath];
    const { hosts } = await setup(async (_request, browse) => {
      const root = listed(await browse());
      expect(root).toMatchObject({ path: app.fsPath, home: app.fsPath, root: app.fsPath, folders: [{ name: 'docs' }, { name: 'escape' }] });
      expect(root).not.toHaveProperty('files');
      expect(root).not.toHaveProperty('parent');
      return { kind: 'connect', path: answers.shift()! };
    });
    expect(await hosts.pick('ssh+h1', 'folder', { buttonLabel: 'Use Folder' })).toBe(path.join(app.fsPath, 'docs'));
    expect(await hosts.pick('ssh+h1', 'folder', {})).toBe(app.fsPath);
  });

  it('cancel answers undefined', async () => {
    const { hosts } = await setup(async () => ({ kind: 'dismissed' }));
    expect(await hosts.pick('ssh+h1', 'file', {})).toBeUndefined();
    expect(await hosts.pick('ssh+h1', 'folder', {})).toBeUndefined();
  });

  it('refuses every path outside the projects: listing above a root, a link out of it, and an answer naming one', async () => {
    const answers = [path.join(outside, 'keys.md'), path.join(app.fsPath, 'escape', 'keys.md'), path.join(app.fsPath, 'docs'), path.join(app.fsPath, 'docs', 'notes.txt')];
    const { hosts, logged } = await setup(async (_request, browse) => {
      expect(await browse(base)).toEqual({ ok: false, error: 'outside' });
      expect(await browse(outside)).toEqual({ ok: false, error: 'outside' });
      expect(await browse(path.join(app.fsPath, 'escape'))).toEqual({ ok: false, error: 'outside' });
      return { kind: 'connect', path: answers.shift()! };
    });
    // outside every root, through a link out of the project, a folder for a file, a file the extensions leave out
    for (let index = 0; index < 4; index++) expect(await hosts.pick('ssh+h1', 'file', { extensions: ['md'] })).toBeUndefined();
    expect(logged.filter((line) => line.startsWith('[remote] refused the picked path'))).toHaveLength(4);
  });

  // the listing filters by name: a dotfile has no extension there, so an answer naming one is refused the same way
  it('judges a picked file by its name as the listing does, not by its path', async () => {
    fs.writeFileSync(path.join(app.fsPath, '.env'), 'SECRET=1');
    const { hosts } = await setup(async (_request, browse) => {
      expect(listed(await browse())).toMatchObject({ files: [] });
      return { kind: 'connect', path: path.join(app.fsPath, '.env') };
    });
    expect(await hosts.pick('ssh+h1', 'file', { extensions: ['env'] })).toBeUndefined();
  });

  it('starts at the first project when the default path lies outside the projects', async () => {
    const other: Project = { key: 'ssh+h1|other', fsPath: path.join(base, 'srv'), name: 'srv' };
    const { hosts } = await setup(async (_request, browse) => {
      expect(listed(await browse())).toMatchObject({ path: app.fsPath });
      return { kind: 'dismissed' };
    }, () => [app, other]);
    await hosts.pick('ssh+h1', 'folder', { defaultPath: outside });
  });

  it('adds no project while a picker is open', async () => {
    const { hosts, addProject } = await setup(async (request, browse) => {
      await expect(hosts.pickFolder(request.hostId!, app.fsPath)).rejects.toThrow('A picker adds no project');
      expect(listed(await browse())).toMatchObject({ root: app.fsPath });
      return { kind: 'dismissed' };
    });
    await hosts.pick('ssh+h1', 'folder', {});
    expect(addProject).not.toHaveBeenCalled();
  });

  it('takes a picked path only as the answer of an open picker', () => {
    const connect: OverlayRequest = { kind: 'connect', hostId: 'h1', hosts: [], sshConfigAliases: [] };
    const picker: OverlayRequest = { ...connect, pick: { mode: 'file', hostName: 'prod-1', roots: ['/srv/app'] } };
    expect(parseOverlayAnswer({ kind: 'connect', path: '/srv/app/a.md' }, connect)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'connect', path: '/srv/app/a.md' }, picker)).toEqual({ kind: 'connect', path: '/srv/app/a.md' });
    expect(parseOverlayAnswer({ kind: 'connect', path: '' }, picker)).toBeUndefined();
    expect(parseConnectRequest({ kind: 'connect', hosts: [], sshConfigAliases: [], pick: { mode: 'file', hostName: 'prod-1', roots: [] } })).toBeUndefined();
  });
});
