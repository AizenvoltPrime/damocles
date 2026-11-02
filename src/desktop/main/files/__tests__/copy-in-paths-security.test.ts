import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    removeListener: vi.fn(),
  },
  WebContentsView: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
}));

import { folderKey } from '../../../../core/workspace-folders/folder-key';
import type { Project } from '../../../local-services/confine';
import { MAX_COPY_IN_PATH_LENGTH, SHELL_CHANNELS } from '../../../preload/shell-channels';
import { WORKSPACE_TO_CLIENT } from '../../../workspace/messages';
import { SHELL_PAGE_URL } from '../../protocol';
import { MAX_COPY_IN_REQUEST_CHARS, ShellHost, parseFilesCopyIn, type ShellActions } from '../../shell';
import type { TransferRequest } from '../file-transfer';
import { TransferGestures, type TransferGestureDeps } from '../transfer-gestures';

// Paths a drop, a paste or the picker names are checked in main before any copy starts, and only the shell's own page can
// name them.

const posix = process.platform !== 'win32';
let root: string;
let project: Project;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-copy-in-paths-')));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'a.png'), 'png');
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function gestures(options: { readonly remote?: boolean } = {}) {
  const started: TransferRequest[] = [];
  const notices: string[] = [];
  const deps: TransferGestureDeps = {
    start: vi.fn(async (request: TransferRequest) => {
      started.push(request);
      return { ok: true as const, transferId: started.length };
    }),
    connected: () => true,
    transfers: () => true,
    projects: () => [project],
    target: () => (options.remote ? { os: 'linux', host: 'prod-1' } : { os: process.platform }),
    localPathOf: (_key, relativeDir) => (options.remote ? undefined : path.join(project.fsPath, ...(relativeDir === '' ? [] : relativeDir.split('/')))),
    kindOf: async () => 'dir',
    clipboard: { current: () => undefined, clearCut: vi.fn() } as unknown as TransferGestureDeps['clipboard'],
    askChecked: vi.fn(async () => ({ action: 0, checked: false })),
    notify: (_severity, message) => notices.push(message),
    setting: () => false,
    stopAsking: vi.fn(async () => undefined),
    pickToCopyIn: async () => undefined,
    pickDownloadFolder: async () => undefined,
    pickDownloadFile: async () => undefined,
    lastDownloadFolder: () => undefined,
    rememberDownloadFolder: vi.fn(async () => undefined),
    platform: process.platform,
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
    log: () => undefined,
  };
  const subject = new TransferGestures(deps);
  const copyIn = (paths: readonly string[], relativeDir = 'src/assets') => subject.copyIn({ projectKey: project.key, relativeDir, paths, withoutPath: 0, origin: 'drop' });
  return { copyIn, started, notices, subject };
}

describe('the paths a copy in names', () => {
  it('starts a copy of absolute paths present on disk, the item as named', async () => {
    const { copyIn, started } = gestures();
    const paths = [path.join(root, 'images'), path.join(root, 'images', 'a.png')];
    expect(await copyIn(paths)).toEqual({ ok: true, transferId: 1 });
    expect(started[0]!.sources).toEqual(paths.map((candidate) => ({ kind: 'local', path: candidate })));
  });

  it.each([
    ['a relative path', 'images/a.png'],
    // present under the working folder, so only the absolute check refuses it
    ['a relative path that lstat finds', 'package.json'],
    ['a dot-relative path', `.${path.sep}images`],
    ['a missing path', path.join(os.tmpdir(), 'dm-copy-in-paths-missing', 'gone.png')],
  ])('refuses %s, and starts nothing for the whole request', async (_what, bad) => {
    const { copyIn, started, notices } = gestures();
    expect(await copyIn([path.join(root, 'images'), bad])).toEqual({ ok: false, reason: 'refused' });
    expect(started).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('refuses a missing path in a folder that exists, toward a local and a remote project', async () => {
    for (const remote of [false, true]) {
      const { copyIn, started } = gestures({ remote });
      expect(await copyIn([path.join(root, 'images', 'gone.png')])).toEqual({ ok: false, reason: 'refused' });
      expect(started).toEqual([]);
    }
  });

  it('refuses the destination folder itself and every folder above it', async () => {
    for (const bad of [path.join(project.fsPath, 'src', 'assets'), path.join(project.fsPath, 'src'), project.fsPath, root]) {
      const { copyIn, started } = gestures();
      expect(await copyIn([bad]), bad).toEqual({ ok: false, reason: 'refused' });
      expect(started, bad).toEqual([]);
    }
  });

  it.runIf(!posix)('refuses a folder above the destination however its case is spelled', async () => {
    const { copyIn, started } = gestures();
    expect(await copyIn([project.fsPath.toUpperCase()])).toEqual({ ok: false, reason: 'refused' });
    expect(started).toEqual([]);
  });

  it('refuses a folder above the destination named through a folder link', async () => {
    fs.symlinkSync(root, path.join(os.tmpdir(), `dm-copy-in-alias-${path.basename(root)}`), posix ? 'dir' : 'junction');
    const alias = path.join(os.tmpdir(), `dm-copy-in-alias-${path.basename(root)}`);
    try {
      const { copyIn, started } = gestures();
      expect(await copyIn([path.join(alias, 'proj', 'src')])).toEqual({ ok: false, reason: 'refused' });
      expect(started).toEqual([]);
    } finally {
      fs.rmSync(alias, { recursive: false, force: true });
    }
  });

  it('accepts a link to a folder above the destination, which copies as the link itself', async () => {
    const link = path.join(root, 'images', 'to-project');
    fs.symlinkSync(project.fsPath, link, posix ? 'dir' : 'junction');
    const { copyIn, started } = gestures();
    expect(await copyIn([link])).toEqual({ ok: true, transferId: 1 });
    expect(started[0]!.sources).toEqual([{ kind: 'local', path: link }]);
  });

  it('accepts a folder beside the destination whose name only starts like one above it', async () => {
    fs.mkdirSync(path.join(project.fsPath, 'sr'));
    fs.mkdirSync(path.join(project.fsPath, 'src', 'asset'));
    const { copyIn, started } = gestures();
    expect(await copyIn([path.join(project.fsPath, 'sr'), path.join(project.fsPath, 'src', 'asset')])).toEqual({ ok: true, transferId: 1 });
    expect(started).toHaveLength(1);
  });

  it('on a remote project, a local folder with the same path as the destination is not its ancestor', async () => {
    const { copyIn, started } = gestures({ remote: true });
    expect(await copyIn([project.fsPath])).toEqual({ ok: true, transferId: 1 });
    expect(started).toHaveLength(1);
  });

  it('refuses a project the window does not have', async () => {
    const { subject, started } = gestures();
    expect(await subject.copyIn({ projectKey: 'another-key', relativeDir: '', paths: [path.join(root, 'images')], withoutPath: 0, origin: 'drop' })).toEqual({ ok: false, reason: 'refused' });
    expect(started).toEqual([]);
  });

  it('counts files with no path on this computer into a notice and never copies them', async () => {
    const { subject, started, notices } = gestures();
    expect(await subject.copyIn({ projectKey: project.key, relativeDir: '', paths: [], withoutPath: 2, origin: 'drop' })).toEqual({ ok: false, reason: 'refused' });
    expect(started).toEqual([]);
    expect(notices).toHaveLength(1);
  });
});

describe('nothing a target sends starts a transfer', () => {
  it('the daemon\'s workspace channel asks this computer only the damocles command\'s relay, which never copies, and its events are watch, search, listing and terminal output only', () => {
    expect(Object.keys(WORKSPACE_TO_CLIENT.requests)).toEqual(['cli.request']);
    const cliRequests = fs.readFileSync(path.join(__dirname, '..', '..', 'cli-requests.ts'), 'utf8');
    expect(cliRequests).not.toMatch(/file-transfer|transfer-gestures|FileTransfer|copyIn|receiveFile/);
    expect(Object.keys(WORKSPACE_TO_CLIENT.events).every((name) => /^(files\.watch(Event|Limit)|search\.|quickOpen\.|terminals\.)/.test(name))).toBe(true);
  });
});

describe('the copy-in request from the shell', () => {
  it('refuses a destination outside the project, a non-string path, a picker origin and extra fields', () => {
    const valid = { projectKey: project.key, relativeDir: 'src', paths: [path.join(root, 'images')], withoutPath: 0, origin: 'drop' };
    expect(parseFilesCopyIn(valid)).toEqual(valid);
    for (const bad of [
      { ...valid, relativeDir: '../..' },
      { ...valid, relativeDir: '/etc' },
      { ...valid, paths: [42] },
      { ...valid, paths: [''] },
      { ...valid, origin: 'picker' },
      { ...valid, origin: 'target' },
      { ...valid, withoutPath: -1 },
      { ...valid, extra: true },
    ]) {
      expect(parseFilesCopyIn(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('refuses paths whose characters together pass MAX_COPY_IN_REQUEST_CHARS, each path within its own limit', () => {
    const long = `C:\\${'a'.repeat(MAX_COPY_IN_PATH_LENGTH - 3)}`;
    const count = Math.floor(MAX_COPY_IN_REQUEST_CHARS / long.length);
    const request = { projectKey: project.key, relativeDir: 'src', paths: Array.from({ length: count }, () => long), withoutPath: 0, origin: 'drop' };
    expect(parseFilesCopyIn(request)?.paths).toHaveLength(count);
    expect(parseFilesCopyIn({ ...request, paths: [...request.paths, long] })).toBeUndefined();
  });

  it('starts a transfer only for the window page\'s main frame: another view, a subframe or another page is rejected first', async () => {
    const contents = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: { url: SHELL_PAGE_URL, parent: null },
      loadURL: vi.fn(async () => undefined),
      getZoomFactor: () => 1,
      isFocused: () => false,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    });
    const window = { webContents: contents, isDestroyed: () => false } as never;
    const files = Object.fromEntries(['copyIn', 'pickCopyIn', 'dropRow', 'setClipboard', 'clearClipboard', 'paste', 'download', 'cancelTransfer'].map((name) => [name, vi.fn(async () => ({ ok: true, transferId: 1 }))]));
    ipc.handlers.clear();
    new ShellHost(window, { files } as unknown as ShellActions, () => undefined, () => undefined);
    const ref = { projectKey: project.key, relativePath: 'src' };
    const calls: Array<[string, unknown]> = [
      [SHELL_CHANNELS.filesCopyIn, { projectKey: project.key, relativeDir: 'src', paths: [path.join(root, 'images')], withoutPath: 0, origin: 'drop' }],
      [SHELL_CHANNELS.filesPickCopyIn, ref],
      [SHELL_CHANNELS.filesDropRow, { from: { projectKey: project.key, relativePath: 'src/a.ts' }, toDir: ref, copy: true }],
      [SHELL_CHANNELS.filesPaste, { toDir: ref }],
      [SHELL_CHANNELS.filesDownload, ref],
      [SHELL_CHANNELS.filesClipboardSet, { op: 'copy', ref }],
    ];
    const foreigners = [
      { sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } },
      { sender: contents, senderFrame: { url: SHELL_PAGE_URL, parent: {} } },
      { sender: contents, senderFrame: { url: 'app://damocles/webview/index.html', parent: null } },
    ];
    for (const [channel, payload] of calls) {
      const handler = ipc.handlers.get(channel);
      expect(handler, channel).toBeDefined();
      for (const sender of foreigners) await expect(Promise.resolve(handler!(sender, payload)), channel).rejects.toThrow('Rejected');
    }
    for (const action of Object.values(files)) expect(action).not.toHaveBeenCalled();
    await ipc.handlers.get(SHELL_CHANNELS.filesCopyIn)!({ sender: contents, senderFrame: contents.mainFrame }, calls[0]![1]);
    expect(files['copyIn']).toHaveBeenCalledOnce();
    // a download names an item under the root, never the root itself
    const download = ipc.handlers.get(SHELL_CHANNELS.filesDownload)!;
    await expect(Promise.resolve(download({ sender: contents, senderFrame: contents.mainFrame }, { projectKey: project.key, relativePath: '' }))).rejects.toThrow('Malformed download');
    expect(files['download']).not.toHaveBeenCalled();
    await download({ sender: contents, senderFrame: contents.mainFrame }, ref);
    expect(files['download']).toHaveBeenCalledWith(ref);
  });
});
