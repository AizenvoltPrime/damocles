import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { WorkspaceManager } from '../workspace-manager';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { folderKey } from '../../workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { LocalizedError } from '../../../shared/localized-text';

let root: string;
let ws: string;
let folder: FolderTarget;
let platform: FakePlatform;

function makeManager(workspaceFolders: readonly string[] = []): WorkspaceManager {
  platform = createFakePlatform({ folders: workspaceFolders.map((fsPath) => ({ fsPath, name: path.basename(fsPath) })) });
  return new WorkspaceManager({ postMessage: () => {}, getPanels: () => new Map(), platform });
}

const opened = () => [...platform.editor.openedFiles, ...platform.shell.revealedPaths.map((p) => ({ revealed: p }))];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-open-file-'));
  ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.png'), '');
  fs.writeFileSync(path.join(ws, 'a.ts'), '');
  folder = { key: folderKey(ws), fsPath: ws, name: 'ws', label: 'ws', projectScope: true };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceManager.openFile', () => {
  it('opens a relative path with the default editor, resolved against the folder', async () => {
    const manager = makeManager();
    await manager.openFile('src/a.png', undefined, folder, 'host-1');

    expect(platform.editor.openedFiles).toEqual([{ path: path.resolve(ws, 'src/a.png'), options: { panelId: 'host-1' } }]);
  });

  it('passes the line for a line', async () => {
    const manager = makeManager();
    await manager.openFile(path.join(ws, 'a.ts'), 12, folder, 'host-1');

    expect(platform.editor.openedFiles).toEqual([{ path: path.join(ws, 'a.ts'), options: { line: 12, panelId: 'host-1' } }]);
  });

  it('shows the error toast and opens nothing when the path does not exist', async () => {
    const manager = makeManager();
    await manager.handleOpenFile('host-1', 'missing.png', undefined, folder);

    expect(platform.notifications.calls).toEqual([{ level: 'error', message: 'Could not open file: missing.png', text: { message: 'Could not open file: {0}', args: ['missing.png'] }, actions: [] }]);
    expect(opened()).toEqual([]);
  });

  describe('a leading ~', () => {
    let home: string;
    beforeEach(() => {
      home = path.join(root, 'home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'notes.txt'), '');
      // os.homedir() reads USERPROFILE on Windows and HOME elsewhere
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('HOME', home);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(process.platform === 'win32' ? ['~/notes.txt', '~\\notes.txt'] : ['~/notes.txt'])('expands %s against the home of the chat\'s machine, as pi\'s tools do', async (filePath) => {
      const manager = makeManager([ws]);
      await manager.handleOpenFile('host-1', filePath, undefined, folder);
      expect(platform.notifications.calls).toEqual([]);
      expect(platform.editor.openedFiles.map((file) => file.path)).toEqual([path.join(home, 'notes.txt')]);
    });

    it('reads ~ alone as the home folder', async () => {
      const manager = makeManager([ws]);
      await manager.handleOpenFile('host-1', '~', undefined, folder);
      expect(platform.notifications.calls).toEqual([{ level: 'error', message: 'Could not open file: ~', text: { message: 'Could not open file: {0}', args: ['~'] }, actions: [] }]);
    });
  });

  it('keeps a name that only starts with ~ relative to the folder', async () => {
    fs.writeFileSync(path.join(ws, '~notes.txt'), '');
    const manager = makeManager([ws]);
    await manager.openFile('~notes.txt', undefined, folder, 'host-1');
    expect(platform.editor.openedFiles.map((file) => file.path)).toEqual([path.join(ws, '~notes.txt')]);
  });

  it.runIf(process.platform === 'win32')('hands a UNC or device path no folder holds to the editor without a stat, which would reach the share', async () => {
    const manager = makeManager([ws]);
    const stat = vi.spyOn(fs.promises, 'stat');
    for (const target of ['\\\\server\\share\\x.txt', '//server/share/x.txt', '\\\\?\\C:\\x.txt', '\\\\.\\pipe\\x']) await manager.openFile(target, 3, folder, 'host-1');
    expect(stat).not.toHaveBeenCalled();
    expect(platform.editor.openedFiles.map((file) => file.path)).toEqual(['\\\\server\\share\\x.txt', '//server/share/x.txt', '\\\\?\\C:\\x.txt', '\\\\.\\pipe\\x']);
    stat.mockRestore();
  });

  it.runIf(process.platform === 'win32')('hands a drive path no folder holds whose realpath is a share to the editor without a stat', async () => {
    const manager = makeManager([ws]);
    vi.spyOn(platform.confinement, 'confineExisting').mockResolvedValueOnce({ ok: true, path: '\\\\nas\\data\\x.txt' });
    const stat = vi.spyOn(fs.promises, 'stat');
    await manager.openFile('Y:\\x.txt', 2, folder, 'host-1');
    expect(stat).not.toHaveBeenCalled();
    expect(platform.editor.openedFiles).toEqual([{ path: 'Y:\\x.txt', options: { line: 2, panelId: 'host-1' } }]);
    stat.mockRestore();
  });

  it('shows a LocalizedError the editor answers with in its own text, and any other failure with its reason', async () => {
    const manager = makeManager();
    const refusal = { message: 'Damocles does not open {0}: it is on a network share or a device outside your projects.', args: ['\\\\server\\share\\x.txt'] };
    vi.spyOn(platform.editor, 'openFile').mockRejectedValueOnce(new LocalizedError(refusal)).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await manager.handleOpenFile('host-1', path.join(ws, 'a.ts'), undefined, folder);
    await manager.handleOpenFile('host-1', 'a.ts', undefined, folder);
    expect(platform.notifications.calls.map((call) => call.text)).toEqual([refusal, { message: 'Could not open {0}: {1}', args: ['a.ts', { message: '{0}', args: ['EACCES: permission denied'] }] }]);
  });

  it('says why a folder in the workspace could not be revealed', async () => {
    const manager = makeManager([ws]);
    vi.spyOn(platform.shell, 'revealPath').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await manager.handleOpenFile('host-1', 'src', undefined, folder);
    expect(platform.notifications.calls.map((call) => call.message)).toEqual(['Could not open src: EACCES: permission denied']);
  });

  it.each([
    ['a folder', 'src'],
    ['a symlinked folder', 'linked'],
  ])('reveals %s inside the workspace in the Explorer', async (_label, name) => {
    // A junction needs no privilege on Windows; POSIX ignores the type.
    fs.symlinkSync(path.join(ws, 'src'), path.join(ws, 'linked'), 'junction');
    const manager = makeManager([ws]);
    await manager.openFile(name, undefined, folder, 'host-1');

    expect(opened()).toEqual([{ revealed: path.resolve(ws, name) }]);
  });

  it('shows the checkpoint text beside the file, titled for the checkpoint', async () => {
    const manager = makeManager();
    await manager.showRewindDiff(path.join(ws, 'a.ts'), 'before', 'host-1');

    const [view] = platform.editor.diffs;
    expect(platform.editor.diffs).toHaveLength(1);
    expect(view?.request.title('b.ts')).toEqual({ message: '{0} (At checkpoint ↔ Current)', args: ['b.ts'] });
    expect(view?.request).toMatchObject({
      filePath: path.join(ws, 'a.ts'),
      left: { content: 'before' },
      right: { path: path.join(ws, 'a.ts') },
      purpose: 'checkpoint',
      preview: true,
      panelId: 'host-1',
    });
    expect((view?.request.left as { name: string }).name).toMatch(/^[a-z0-9]+-[a-z0-9]+-a.ts$/);
  });

  it('hands a path whose link leads out of its workspace folder to the editor, after the confinement and with no stat of it', async () => {
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'b.ts'), '');
    fs.symlinkSync(outside, path.join(ws, 'out'), 'junction');
    const manager = makeManager([ws]);
    const confine = vi.spyOn(platform.confinement, 'confineExisting');
    const stat = vi.spyOn(fs.promises, 'stat');
    await manager.openFile('out/b.ts', undefined, folder, 'host-1');
    expect(confine).toHaveBeenCalledWith(ws, 'out/b.ts');
    expect(stat).not.toHaveBeenCalled();
    expect(platform.editor.openedFiles.map((file) => file.path)).toEqual([path.join(ws, 'out', 'b.ts')]);
    stat.mockRestore();
  });

  it('hands a path whose confinement fails (a realpath a virtual drive refuses) to the editor, with no stat', async () => {
    const manager = makeManager([ws]);
    vi.spyOn(platform.confinement, 'confineExisting').mockResolvedValueOnce({ ok: false, reason: 'failed' });
    const stat = vi.spyOn(fs.promises, 'stat');
    await manager.openFile(path.join(ws, 'a.ts'), 4, folder, 'host-1');
    expect(stat).not.toHaveBeenCalled();
    expect(platform.editor.openedFiles).toEqual([{ path: path.join(ws, 'a.ts'), options: { line: 4, panelId: 'host-1' } }]);
    stat.mockRestore();
  });

  it('walks a path outside every workspace folder from its own root before the stat', async () => {
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'c.ts'), '');
    const manager = makeManager([ws]);
    const confine = vi.spyOn(platform.confinement, 'confineExisting');
    await manager.openFile(path.join(outside, 'c.ts'), undefined, folder, 'host-1');
    const drive = path.parse(outside).root;
    expect(confine).toHaveBeenCalledWith(drive, path.relative(drive, path.join(outside, 'c.ts')).split(path.sep).join('/'));
    expect(platform.editor.openedFiles.map((file) => file.path)).toEqual([path.join(outside, 'c.ts')]);
  });

  it('shows the error toast for a folder outside the workspace', async () => {
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    const manager = makeManager([ws]);
    await manager.handleOpenFile('host-1', outside, undefined, folder);

    expect(platform.notifications.calls).toEqual([{ level: 'error', message: `Could not open file: ${outside}`, text: { message: 'Could not open file: {0}', args: [outside] }, actions: [] }]);
    expect(opened()).toEqual([]);
  });
});
