import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../../local-services/confine';
import { MAX_COPY_IN_PATHS, type FilesClipboardChanged, type FilesTransferStartResult } from '../../../preload/shell-channels';
import type { CheckedQuestion } from '../../message-dialog';
import type { TransferRequest } from '../file-transfer';
import { FilesClipboard } from '../files-clipboard';
import { TransferGestures, type TransferGestureDeps } from '../transfer-gestures';

let root: string;
let project: Project;
let changes: FilesClipboardChanged[];
let clipboard: FilesClipboard;
let started: TransferRequest[];
let questions: CheckedQuestion[];
let answers: Array<{ action: number | undefined; checked: boolean }>;
let notices: string[];
let settings: { confirmDragAndDrop: boolean; confirmPasteNative: boolean };
let gestures: TransferGestures;

function gestureDeps(overrides: Partial<TransferGestureDeps> = {}): TransferGestureDeps {
  return {
    start: async (request): Promise<FilesTransferStartResult> => {
      started.push(request);
      return { ok: true, transferId: started.length };
    },
    connected: () => true,
    transfers: () => true,
    projects: () => [project],
    target: () => ({ os: process.platform }),
    localPathOf: (_projectKey, relativeDir) => path.join(project.fsPath, ...(relativeDir === '' ? [] : relativeDir.split('/'))),
    kindOf: async (file) => (fs.statSync(path.join(project.fsPath, file.relativePath)).isDirectory() ? 'dir' : 'file'),
    clipboard,
    askChecked: async (question) => {
      questions.push(question);
      return answers.shift() ?? { action: undefined, checked: false };
    },
    notify: (_severity, message) => notices.push(message),
    setting: (key) => settings[key],
    stopAsking: async (key) => {
      settings[key] = false;
    },
    pickToCopyIn: async () => undefined,
    pickDownloadFolder: async () => undefined,
    pickDownloadFile: async () => undefined,
    lastDownloadFolder: () => undefined,
    rememberDownloadFolder: async () => undefined,
    platform: process.platform,
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    log: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-files-clipboard-')));
  const fsPath = path.join(root, 'proj');
  fs.mkdirSync(path.join(fsPath, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(fsPath, 'src', 'app.ts'), 'app');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  project = { key: 'proj', fsPath, name: 'proj' };
  changes = [];
  clipboard = new FilesClipboard((change) => changes.push(change));
  started = [];
  questions = [];
  answers = [];
  notices = [];
  settings = { confirmDragAndDrop: true, confirmPasteNative: true };
  gestures = new TransferGestures(gestureDeps());
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const app = { projectKey: 'proj', relativePath: 'src/app.ts' };

describe('the Files clipboard', () => {
  it('dims a cut, clears it on Escape, and keeps a copy', () => {
    clipboard.set('cut', app);
    expect(changes).toEqual([{ cut: app }]);
    clipboard.clearCut();
    expect(changes.at(-1)).toEqual({});
    expect(clipboard.current()).toBeUndefined();
    clipboard.set('copy', app);
    expect(changes.at(-1)).toEqual({});
    clipboard.clearCut();
    expect(clipboard.current()).toEqual({ op: 'copy', ref: app });
  });

  it('pastes a copy into its own folder as a copy that keeps both, without asking', async () => {
    clipboard.set('copy', app);
    expect(await gestures.paste({ projectKey: 'proj', relativePath: 'src' })).toEqual({ ok: true, transferId: 1 });
    expect(started).toEqual([{ op: 'copy', sources: [{ kind: 'project', ...app }], destination: { kind: 'project', projectKey: 'proj', relativeDir: 'src' }, keepBothWithItself: true }]);
    expect(questions).toEqual([]);
    expect(clipboard.current()).toEqual({ op: 'copy', ref: app });
  });

  it('pastes a cut as a move, which clears it', async () => {
    clipboard.set('cut', app);
    await gestures.paste({ projectKey: 'proj', relativePath: 'src/deep' });
    expect(started).toEqual([{ op: 'move', sources: [{ kind: 'project', ...app }], destination: { kind: 'project', projectKey: 'proj', relativeDir: 'src/deep' } }]);
    expect(clipboard.current()).toBeUndefined();
    expect(changes.at(-1)).toEqual({});
    expect(await gestures.paste({ projectKey: 'proj', relativePath: 'src' })).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('row drops', () => {
  it('asks before a move, and Don\'t ask again turns the question off', async () => {
    answers.push({ action: 0, checked: true });
    await gestures.dropRow({ from: app, toDir: { projectKey: 'proj', relativePath: 'src/deep' }, copy: false });
    expect(questions.map((question) => [question.message, question.actions, question.checkbox.label])).toEqual([['Move \'app.ts\' into \'deep\'?', ['Move'], 'Don\'t ask again']]);
    expect(settings.confirmDragAndDrop).toBe(false);
    await gestures.dropRow({ from: app, toDir: { projectKey: 'proj', relativePath: '' }, copy: false });
    expect(questions).toHaveLength(1);
    expect(started.map((request) => request.op)).toEqual(['move', 'move']);
  });

  it('copies without asking when the modifier was held, and moves nothing on a cancel', async () => {
    await gestures.dropRow({ from: app, toDir: { projectKey: 'proj', relativePath: 'src/deep' }, copy: true });
    expect(started.map((request) => request.op)).toEqual(['copy']);
    expect(await gestures.dropRow({ from: app, toDir: { projectKey: 'proj', relativePath: 'src/deep' }, copy: false })).toEqual({ ok: false, reason: 'cancelled' });
    expect(started).toHaveLength(1);
  });
});

describe('copy in', () => {
  const drop = (paths: readonly string[], origin: 'drop' | 'paste' = 'drop', withoutPath = 0) => gestures.copyIn({ projectKey: 'proj', relativeDir: 'src', paths, withoutPath, origin });

  it('refuses a relative path, a missing one, and the destination or a folder holding it', async () => {
    for (const candidate of ['relative.txt', path.join(root, 'gone.txt'), project.fsPath, path.join(project.fsPath, 'src'), root]) {
      expect(await drop([candidate]), candidate).toEqual({ ok: false, reason: 'refused' });
    }
    expect(started).toEqual([]);
    expect(await drop([path.join(root, 'outside.txt'), path.join(project.fsPath, 'src', 'deep')])).toEqual({ ok: true, transferId: 1 });
  });

  it('refuses a drive or file system root, even toward a remote project, before anything walks it', async () => {
    gestures = new TransferGestures(gestureDeps({ target: () => ({ os: 'linux', host: 'prod-1' }), localPathOf: () => undefined }));
    expect(await drop([path.parse(root).root])).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual([`'${path.parse(root).root}' is a whole drive. Copy the folders in it instead.`]);
    expect(started).toEqual([]);
  });

  it('refuses with a notice when the destination folder is gone', async () => {
    gestures = new TransferGestures(gestureDeps({ localPathOf: () => path.join(root, 'gone') }));
    expect(await drop([path.join(root, 'outside.txt')])).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual([`'${path.join(root, 'gone')}' is no longer there or cannot be read.`]);
  });

  it('refuses more than MAX_COPY_IN_PATHS items with a notice', async () => {
    expect(await drop(Array.from({ length: MAX_COPY_IN_PATHS + 1 }, () => path.join(root, 'outside.txt')))).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual([`Damocles copies at most ${MAX_COPY_IN_PATHS} items at a time. Copy their folder instead, or fewer at once.`]);
    expect(started).toEqual([]);
  });

  it('refuses files with no disk path with a notice, and copies the rest', async () => {
    expect(await drop([], 'drop', 2)).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual(['2 of the dropped items are not files on this computer, such as an image from a web page, and were not copied.']);
    expect(await drop([path.join(root, 'outside.txt')], 'drop', 1)).toEqual({ ok: true, transferId: 1 });
  });

  it('confirms a paste of OS files, and Don\'t ask again stops the confirm', async () => {
    answers.push({ action: undefined, checked: true });
    expect(await drop([path.join(root, 'outside.txt')], 'paste')).toEqual({ ok: false, reason: 'cancelled' });
    expect(settings.confirmPasteNative).toBe(true);
    answers.push({ action: 0, checked: true });
    expect(await drop([path.join(root, 'outside.txt')], 'paste')).toEqual({ ok: true, transferId: 1 });
    expect(questions.map((question) => question.message)).toEqual(['Paste \'outside.txt\' into \'src\'?', 'Paste \'outside.txt\' into \'src\'?']);
    expect(settings.confirmPasteNative).toBe(false);
    await drop([path.join(root, 'outside.txt')], 'paste');
    expect(questions).toHaveLength(2);
  });

  it('refuses an offline project with the offline message before any question', async () => {
    gestures = new TransferGestures(gestureDeps({ connected: () => false, target: () => ({ os: 'linux', host: 'prod-1' }) }));
    expect(await drop([path.join(root, 'outside.txt')], 'paste')).toEqual({ ok: false, reason: 'offline' });
    expect(notices).toEqual(['prod-1 is offline. Reconnect to copy files.']);
    expect(questions).toEqual([]);
  });
});

describe('download', () => {
  it('is refused on a local project', async () => {
    expect(await gestures.download(app)).toEqual({ ok: false, reason: 'refused' });
  });

  it('saves a file through the Save dialog on the last folder, and a folder as <picked>/<name>', async () => {
    const remembered: string[] = [];
    const savedAt: string[] = [];
    gestures = new TransferGestures(gestureDeps({
      target: () => ({ os: 'linux', host: 'prod-1' }),
      lastDownloadFolder: () => remembered.at(-1),
      rememberDownloadFolder: async (folder) => {
        remembered.push(folder);
      },
      pickDownloadFile: async (defaultPath) => {
        savedAt.push(defaultPath);
        return path.join(root, 'saved', 'renamed.ts');
      },
      pickDownloadFolder: async (defaultPath) => {
        savedAt.push(defaultPath ?? 'the OS default');
        return path.join(root, 'picked');
      },
    }));
    await gestures.download(app);
    await gestures.download({ projectKey: 'proj', relativePath: 'src/deep' });
    // the first Save dialog opens in the OS default with the file's name, the folder picker then on the folder last used
    expect(savedAt).toEqual(['app.ts', path.join(root, 'saved')]);
    expect(remembered).toEqual([path.join(root, 'saved'), path.join(root, 'picked')]);
    expect(started.map((request) => request.destination)).toEqual([{ kind: 'download', folder: path.join(root, 'saved'), name: 'renamed.ts' }, { kind: 'download', folder: path.join(root, 'picked') }]);
  });
});

describe('a host whose Damocles server carries no transfers', () => {
  it('refuses every gesture before any dialog, with a notice naming the host', async () => {
    const pickers: string[] = [];
    gestures = new TransferGestures(gestureDeps({
      transfers: () => false,
      target: () => ({ os: 'linux', host: 'prod-1' }),
      pickToCopyIn: async () => {
        pickers.push('copy in');
        return undefined;
      },
      pickDownloadFile: async () => {
        pickers.push('save');
        return undefined;
      },
    }));
    clipboard.set('copy', app);
    expect(await gestures.copyIn({ projectKey: 'proj', relativeDir: 'src', paths: [path.join(root, 'outside.txt')], withoutPath: 0, origin: 'paste' })).toEqual({ ok: false, reason: 'refused' });
    expect(await gestures.pickCopyIn({ projectKey: 'proj', relativePath: 'src' })).toEqual({ ok: false, reason: 'refused' });
    expect(await gestures.dropRow({ from: app, toDir: { projectKey: 'proj', relativePath: 'src/deep' }, copy: false })).toEqual({ ok: false, reason: 'refused' });
    expect(await gestures.paste({ projectKey: 'proj', relativePath: 'src/deep' })).toEqual({ ok: false, reason: 'refused' });
    expect(await gestures.download(app)).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual(Array(5).fill('The Damocles server on prod-1 is too old to copy files. Reconnect to update it.'));
    expect(questions).toEqual([]);
    expect(pickers).toEqual([]);
    expect(started).toEqual([]);
  });
});

describe('download of a link', () => {
  it('is refused before the Save dialog, naming the link', async () => {
    const pickers: string[] = [];
    gestures = new TransferGestures(gestureDeps({
      target: () => ({ os: 'linux', host: 'prod-1' }),
      kindOf: async () => 'link',
      pickDownloadFile: async () => {
        pickers.push('save');
        return undefined;
      },
      pickDownloadFolder: async () => {
        pickers.push('folder');
        return undefined;
      },
    }));
    expect(await gestures.download({ projectKey: 'proj', relativePath: 'src/latest' })).toEqual({ ok: false, reason: 'refused' });
    expect(notices).toEqual(['\'latest\' is a link. Download the file or folder it leads to instead.']);
    expect(pickers).toEqual([]);
  });
});
