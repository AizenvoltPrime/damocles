import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { Project } from '../../../local-services/confine';
import type { FilesChanged, FilesMutationResult, FilesTransferProgress } from '../../../preload/shell-channels';
import { createFileSystem } from '../../../workspace/file-system';
import { isPartName, type TransferEntry, type TransferResult } from '../../../workspace/transfer-ops';
import type { CheckedQuestion } from '../../message-dialog';
import { TransfersUnsupportedError } from '../../workspace/remote-workspace';
import { NotConnectedError } from '../../workspace/workspaces';
import { CLASHES_CHUNK_NAMES, FileTransferService, linkStaysInside, type FileTransferDeps, type TransferFiles } from '../file-transfer';

const posix = process.platform !== 'win32';
let root: string;
let projects: Project[];
let hosts: Map<string, TransferFiles>;
let offline: Set<string>;
let answers: Array<{ action: number | undefined; checked: boolean }>;
let questions: CheckedQuestion[];
let notices: Array<{ severity: string; message: string; actions: readonly string[] }>;
let progress: FilesTransferProgress[];
let renames: Array<[string, string]>;
let service: FileTransferService;

// projects: local (this computer), prod-1 and prod-2, each on its own folder
const LOCAL = 'local-project';
const PROD1 = 'ssh+one|/srv/app';
const PROD2 = 'ssh+two|/srv/app';

function filesFor(): TransferFiles {
  return createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: path.join(root, 'home'), log: () => undefined });
}

function deps(overrides: Partial<FileTransferDeps> = {}): FileTransferDeps {
  return {
    projects: () => projects,
    filesOf: (projectKey) => {
      if (offline.has(projectKey)) throw new NotConnectedError(`${projectKey} is not connected.`);
      return hosts.get(projectKey)!;
    },
    target: (projectKey) => (projectKey === LOCAL ? { os: process.platform } : { os: process.platform, host: projectKey === PROD1 ? 'prod-1' : 'prod-2' }),
    authorityOf: (projectKey) => (projectKey === LOCAL ? 'local' : projectKey.split('|')[0]!),
    transfers: () => true,
    local: hosts.get(LOCAL)!,
    platform: process.platform,
    askChecked: async (question) => {
      questions.push(question);
      const answer = answers.shift();
      if (!answer) throw new Error(`unexpected question: ${question.message}`);
      return answer;
    },
    notify: async (severity, message, actions) => {
      notices.push({ severity, message, actions });
      return undefined;
    },
    showDetails: async () => undefined,
    renameInProject: async (projectKey, from, renameOnDisk): Promise<FilesMutationResult> => {
      renames.push([projectKey, from]);
      return renameOnDisk();
    },
    progress: (update) => progress.push(update),
    changed: () => undefined,
    reveal: async () => undefined,
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    log: () => undefined,
    ...overrides,
  };
}

const dirOf = (projectKey: string): string => projects.find((project) => project.key === projectKey)!.fsPath;
const at = (projectKey: string, relative: string): string => path.join(dirOf(projectKey), ...relative.split('/'));
const write = (projectKey: string, relative: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(projectKey, relative)), { recursive: true });
  fs.writeFileSync(at(projectKey, relative), text);
};
const read = (projectKey: string, relative: string): string => fs.readFileSync(at(projectKey, relative), 'utf8');

// resolves once the transfer reached an end state
async function settled(transferId: number): Promise<FilesTransferProgress> {
  await vi.waitFor(() => expect(progress.some((update) => update.transferId === transferId && ['done', 'failed', 'cancelled'].includes(update.state))).toBe(true));
  return progress.filter((update) => update.transferId === transferId).at(-1)!;
}

async function run(request: Parameters<FileTransferService['start']>[0]): Promise<FilesTransferProgress> {
  const started = await service.start(request);
  if (!started.ok) throw new Error(`refused: ${started.reason}`);
  return settled(started.transferId);
}

const REPLACE = { action: 0, checked: false };
const KEEP_BOTH = { action: 1, checked: false };
const SKIP = { action: 2, checked: false };

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-file-transfer-')));
  projects = [LOCAL, PROD1, PROD2].map((key, index) => {
    const fsPath = path.join(root, `p${index}`);
    fs.mkdirSync(path.join(fsPath, 'src'), { recursive: true });
    return { key, fsPath, name: `p${index}` };
  });
  hosts = new Map(projects.map((project) => [project.key, filesFor()]));
  offline = new Set();
  answers = [];
  questions = [];
  notices = [];
  progress = [];
  renames = [];
  service = new FileTransferService(deps());
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conflicts', () => {
  beforeEach(() => {
    write(LOCAL, 'in/app.ts', 'new app');
    write(LOCAL, 'in/lib.ts', 'new lib');
    write(PROD1, 'src/app.ts', 'old app');
    write(PROD1, 'src/lib.ts', 'old lib');
  });
  const copyIn = (...names: string[]) => run({ op: 'copy', sources: names.map((name) => ({ kind: 'local' as const, path: at(LOCAL, `in/${name}`) })), destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });

  it('asks Replace, Keep both or Skip for each clash, and applies each answer', async () => {
    answers.push(REPLACE, SKIP);
    expect(await copyIn('app.ts', 'lib.ts')).toMatchObject({ state: 'done', filesTotal: 1 });
    expect(questions.map((question) => [question.message, question.actions, question.checkbox.label])).toEqual([
      ['\'app.ts\' already exists in \'src\'', ['Replace', 'Keep both', 'Skip'], 'Apply to all remaining conflicts'],
      ['\'lib.ts\' already exists in \'src\'', ['Replace', 'Keep both', 'Skip'], 'Apply to all remaining conflicts'],
    ]);
    expect(read(PROD1, 'src/app.ts')).toBe('new app');
    expect(read(PROD1, 'src/lib.ts')).toBe('old lib');
    expect(notices.at(-1)).toMatchObject({ message: 'Copied 1 of 2 items to prod-1. 1 skipped', actions: ['Show details'] });
  });

  it('keeps both as name copy, then name copy 2', async () => {
    answers.push(KEEP_BOTH, KEEP_BOTH);
    await copyIn('app.ts');
    await copyIn('app.ts');
    expect(read(PROD1, 'src/app copy.ts')).toBe('new app');
    expect(read(PROD1, 'src/app copy 2.ts')).toBe('new app');
    expect(read(PROD1, 'src/app.ts')).toBe('old app');
  });

  it('answers every remaining clash with Apply to all', async () => {
    answers.push({ action: 0, checked: true });
    await copyIn('app.ts', 'lib.ts');
    expect(questions).toHaveLength(1);
    expect(read(PROD1, 'src/app.ts')).toBe('new app');
    expect(read(PROD1, 'src/lib.ts')).toBe('new lib');
    answers.push({ action: 2, checked: true });
    write(LOCAL, 'in/app.ts', 'newer app');
    write(LOCAL, 'in/lib.ts', 'newer lib');
    await copyIn('app.ts', 'lib.ts');
    expect(questions).toHaveLength(2);
    expect(read(PROD1, 'src/app.ts')).toBe('new app');
    answers.push({ action: 1, checked: true });
    await copyIn('app.ts', 'lib.ts');
    expect(questions).toHaveLength(3);
    expect(fs.readdirSync(at(PROD1, 'src')).sort()).toEqual(['app copy.ts', 'app.ts', 'lib copy.ts', 'lib.ts']);
  });

  it('copies nothing when the question is cancelled', async () => {
    answers.push({ action: undefined, checked: false });
    expect(await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/app.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'cancelled' });
    expect(read(PROD1, 'src/app.ts')).toBe('old app');
    expect(progress.map((update) => update.state)).toEqual(['preparing', 'cancelled']);
  });

  it('merges a folder clash and asks only about its files', async () => {
    write(LOCAL, 'src/app.ts', 'new app');
    write(LOCAL, 'src/deep/fresh.ts', 'fresh');
    answers.push(REPLACE);
    await run({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'src') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: '' } });
    expect(questions.map((question) => question.message)).toEqual(['\'app.ts\' already exists in \'src\'']);
    expect(read(PROD1, 'src/app.ts')).toBe('new app');
    expect(read(PROD1, 'src/lib.ts')).toBe('old lib');
    expect(read(PROD1, 'src/deep/fresh.ts')).toBe('fresh');
  });

  it('offers only Keep both and Skip when a file meets a folder', async () => {
    fs.mkdirSync(at(PROD1, 'src/thing'));
    write(LOCAL, 'in/thing', 'a file');
    answers.push({ action: 0, checked: false });
    await copyIn('thing');
    expect(questions[0]!.actions).toEqual(['Keep both', 'Skip']);
    expect(read(PROD1, 'src/thing copy')).toBe('a file');
  });

  it('keeps both without asking for a copy into the folder it came from', async () => {
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/app.ts' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' }, keepBothWithItself: true });
    expect(questions).toEqual([]);
    expect(read(PROD1, 'src/app copy.ts')).toBe('old app');
  });
});

describe('a destination that cannot be listed', () => {
  it('refuses the transfer with a notice naming the folder and the reason', async () => {
    write(LOCAL, 'in/a.ts', 'a');
    vi.spyOn(hosts.get(PROD1)!, 'clashes').mockResolvedValue({ ok: false, reason: 'failed', code: 'EACCES', message: 'permission denied' });
    expect(await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/a.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'failed' });
    expect(notices.map((notice) => notice.message)).toEqual(['Damocles could not copy the files: Damocles could not read the folder \'src\': permission denied']);
    expect(progress.map((update) => update.state)).toEqual(['preparing', 'failed']);
  });
});

describe('refusals', () => {
  it('refuses a folder into itself or a descendant', async () => {
    write(PROD1, 'src/deep/a.ts', 'a');
    for (const relativeDir of ['src', 'src/deep']) {
      expect(await service.start({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src' }], destination: { kind: 'project', projectKey: PROD1, relativeDir } })).toEqual({ ok: false, reason: 'refused' });
    }
    expect(notices.map((notice) => notice.message)).toEqual(['Damocles can\'t copy \'src\' into itself.', 'Damocles can\'t copy \'src\' into itself.']);
    expect(read(PROD1, 'src/deep/a.ts')).toBe('a');
  });

  it('refuses a transfer to an offline host with the offline message, and queues nothing', async () => {
    offline.add(PROD1);
    write(LOCAL, 'in/a.ts', 'a');
    expect(await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/a.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'offline' });
    expect(notices).toEqual([{ severity: 'warning', message: 'prod-1 is offline. Reconnect to copy files.', actions: [] }]);
    expect(progress).toEqual([]);
    offline.delete(PROD1);
    expect(fs.readdirSync(at(PROD1, 'src'))).toEqual([]);
  });
});

describe('routing', () => {
  it('moves inside one project through the documents\' rename, so open tabs follow', async () => {
    write(LOCAL, 'src/app.ts', 'app');
    fs.mkdirSync(at(LOCAL, 'lib'));
    await run({ op: 'move', sources: [{ kind: 'project', projectKey: LOCAL, relativePath: 'src/app.ts' }], destination: { kind: 'project', projectKey: LOCAL, relativeDir: 'lib' } });
    expect(renames).toEqual([[LOCAL, 'src/app.ts']]);
    expect(read(LOCAL, 'lib/app.ts')).toBe('app');
    expect(fs.existsSync(at(LOCAL, 'src/app.ts'))).toBe(false);
  });

  it('copies between two projects of one host on that host, never reading the bytes', async () => {
    const sameHost = deps({ authorityOf: () => 'ssh+one' });
    const readFile = vi.spyOn(hosts.get(PROD1)!, 'readFile');
    service = new FileTransferService(sameHost);
    write(PROD1, 'src/a.ts', 'a');
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/a.ts' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    expect(read(PROD2, 'src/a.ts')).toBe('a');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('between hosts, deletes each source item only after its copy finished, and keeps one whose copy failed', async () => {
    write(PROD1, 'src/a.ts', 'a');
    write(PROD1, 'src/b.ts', 'b');
    write(PROD2, 'src/b.ts', 'taken');
    const order: string[] = [];
    const dest = hosts.get(PROD2)!;
    const receive = dest.receiveFile.bind(dest);
    vi.spyOn(dest, 'receiveFile').mockImplementation(async (...args) => {
      const result = await receive(...args);
      order.push(`landed ${args[2]} ${result.ok}`);
      return result;
    });
    const source = hosts.get(PROD1)!;
    const remove = source.deleteEntry.bind(source);
    vi.spyOn(source, 'deleteEntry').mockImplementation(async (...args) => {
      order.push(`deleted ${args[1]} copy=${fs.existsSync(at(PROD2, args[1]))}`);
      return remove(...args);
    });
    vi.spyOn(source, 'removeFolder');
    answers.push(SKIP);
    await run({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: '' } });
    expect(order).toEqual(['landed a.ts true', 'deleted src/a.ts copy=true']);
    expect(read(PROD2, 'src/a.ts')).toBe('a');
    expect(read(PROD1, 'src/b.ts')).toBe('b');
    expect(fs.existsSync(at(PROD1, 'src/a.ts'))).toBe(false);
    // the source folder still holds the skipped file
    expect(fs.existsSync(at(PROD1, 'src'))).toBe(true);
  });

  it('runs one transfer per project at a time, in the order they started', async () => {
    write(LOCAL, 'in/one.bin', 'x'.repeat(300_000));
    write(LOCAL, 'in/two.ts', 'two');
    const first = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/one.bin') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    const second = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/two.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    if (!first.ok || !second.ok) throw new Error('refused');
    await settled(second.transferId);
    const states = progress.map((update) => `${update.transferId}:${update.state}`);
    expect(states.indexOf(`${first.transferId}:done`)).toBeLessThan(states.indexOf(`${second.transferId}:running`));
    expect(progress.at(-1)).toMatchObject({ state: 'done', filesDone: 1, filesTotal: 1, bytesDone: 3, bytesTotal: 3 });
  });
});

describe('cancel', () => {
  it('stops after the current file\'s part is removed; files that finished stay', async () => {
    write(LOCAL, 'in/a.ts', 'first');
    write(LOCAL, 'in/z.bin', 'y'.repeat(1_000_000));
    const dest = hosts.get(PROD1)!;
    const receive = dest.receiveFile.bind(dest);
    let transferId = 0;
    let sent = 0;
    vi.spyOn(dest, 'receiveFile').mockImplementation(async (project, dir, name, source, options) => {
      if (name !== 'z.bin') return receive(project, dir, name, source, options);
      async function* cancelling(): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
          yield chunk;
          sent += chunk.length;
          if (sent >= 100_000) service.cancel(transferId);
        }
      }
      return receive(project, dir, name, cancelling(), options);
    });
    const started = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    if (!started.ok) throw new Error('refused');
    transferId = started.transferId;
    expect(await settled(transferId)).toMatchObject({ state: 'cancelled' });
    expect(read(PROD1, 'src/in/a.ts')).toBe('first');
    expect(fs.readdirSync(at(PROD1, 'src/in'))).toEqual(['a.ts']);
    expect(fs.readdirSync(at(PROD1, 'src/in')).filter(isPartName)).toEqual([]);
    // the cancel stops the file's bytes where they are, not after the rest of the file
    expect(sent).toBeLessThan(1_000_000);
  });
});

describe('links between machines', () => {
  it('turns a relative Windows link target\'s backslashes into slashes for a POSIX host', async () => {
    service = new FileTransferService(deps({ target: (projectKey) => (projectKey === LOCAL ? { os: 'win32' } : { os: 'linux', host: 'prod-1' }), platform: 'win32' }));
    write(LOCAL, 'in/img/a.png', 'png');
    const local = hosts.get(LOCAL)!;
    const real: TransferEntry[] = [];
    for await (const page of local.walk(projects[0]!, 'in')) real.push(...page);
    vi.spyOn(local, 'walk').mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* walk() {
        yield [...real, { ...real.at(-1)!, relativePath: 'latest', kind: 'link' as const, size: 0, linkTarget: 'img\\a.png' }];
      },
    }));
    const made: string[] = [];
    vi.spyOn(hosts.get(PROD1)!, 'makeLink').mockImplementation(async (_project, _dir, _name, target) => {
      made.push(target);
      return { ok: true };
    });
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: LOCAL, relativePath: 'in' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    expect(made).toEqual(['img/a.png']);
  });
});

describe('cancel while waiting', () => {
  it('ends a transfer still queued at once, which then never runs', async () => {
    write(LOCAL, 'in/one.bin', 'x'.repeat(300_000));
    write(LOCAL, 'in/two.ts', 'two');
    const first = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/one.bin') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    const second = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/two.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    if (!first.ok || !second.ok) throw new Error('refused');
    service.cancel(second.transferId);
    expect(progress.filter((update) => update.transferId === second.transferId).map((update) => update.state)).toEqual(['preparing', 'queued', 'cancelled']);
    await settled(first.transferId);
    expect(fs.readdirSync(at(PROD1, 'src'))).toEqual(['one.bin']);
    expect(progress.filter((update) => update.transferId === second.transferId)).toHaveLength(3);
  });
});

describe('download', () => {
  // a target walk listing names and links this computer must refuse
  function hostileWalk(entries: TransferEntry[]): void {
    vi.spyOn(hosts.get(PROD1)!, 'walk').mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* walk() {
        yield entries;
      },
    }));
  }

  it('lands a remote folder as <picked>/<name>, without a name this computer refuses or a link that leaves it', async () => {
    write(PROD1, 'logs/app.log', 'log');
    const real: TransferEntry[] = [];
    for await (const page of hosts.get(PROD1)!.walk(projects[1]!, 'logs')) real.push(...page);
    const fake = (relativePath: string, kind: TransferEntry['kind'], linkTarget?: string): TransferEntry => ({ ...real[1]!, relativePath, kind, size: 0, ...(linkTarget !== undefined ? { linkTarget } : {}) });
    hostileWalk([real[0]!, real[1]!, fake('..', 'file'), fake('passwd', 'link', '/etc/passwd'), fake('a/b', 'file'), fake('CON', 'file')]);
    // the target serves a byte for any name it listed, as a hostile one would
    const target = hosts.get(PROD1)!;
    const readReal = target.readFile.bind(target);
    vi.spyOn(target, 'readFile').mockImplementation(async (project, relativePath) => (relativePath === 'logs/app.log'
      ? readReal(project, relativePath)
      : { ok: true, size: 0, chunks: (async function* none(): AsyncGenerator<Uint8Array> {})() }));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    // main checks every name before any reaches the receiving host, whose parser would refuse it as a violation
    const named: string[] = [];
    const local = hosts.get(LOCAL)!;
    const clashes = local.clashes.bind(local);
    vi.spyOn(local, 'clashes').mockImplementation(async (project, dir, names) => {
      named.push(...names);
      return clashes(project, dir, names);
    });
    const receive = local.receiveFile.bind(local);
    vi.spyOn(local, 'receiveFile').mockImplementation(async (project, dir, name, source, options) => {
      named.push(name);
      return receive(project, dir, name, source, options);
    });
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    expect(named.filter((name) => ['..', 'a/b'].includes(name) || (process.platform === 'win32' && name === 'CON'))).toEqual([]);
    expect(fs.readFileSync(path.join(picked, 'logs', 'app.log'), 'utf8')).toBe('log');
    expect(fs.readdirSync(path.join(picked, 'logs')).sort()).toEqual(process.platform === 'win32' ? ['app.log'] : ['CON', 'app.log']);
    expect(fs.readdirSync(picked)).toEqual(['logs']);
    expect(notices.at(-1)!.message).toBe(process.platform === 'win32' ? `Downloaded 1 of 5 items to ${picked}. 4 skipped` : `Downloaded 2 of 5 items to ${picked}. 3 skipped`);
  });

  it.runIf(posix)('recreates a relative link that stays inside the download', async () => {
    write(PROD1, 'logs/app.log', 'log');
    fs.symlinkSync('app.log', at(PROD1, 'logs/latest'));
    fs.symlinkSync('/etc/passwd', at(PROD1, 'logs/passwd'));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    expect(fs.readlinkSync(path.join(picked, 'logs', 'latest'))).toBe('app.log');
    expect(fs.existsSync(path.join(picked, 'logs', 'passwd'))).toBe(false);
  });

  it('first filters a link from another machine lexically: relative, never above the copied item', () => {
    expect(linkStaysInside('latest', 'app.log', 'linux')).toBe(true);
    expect(linkStaysInside('sub/up', '../app.log', 'linux')).toBe(true);
    expect(linkStaysInside('d1/b', '..', 'linux')).toBe(true);
    expect(linkStaysInside('passwd', '/etc/passwd', 'linux')).toBe(false);
    expect(linkStaysInside('up', '../outside', 'linux')).toBe(false);
    expect(linkStaysInside('w', 'C:\\Windows', 'win32')).toBe(false);
    expect(linkStaysInside('w', '..\\..\\x', 'win32')).toBe(false);
    expect(linkStaysInside('', 'anything', 'linux')).toBe(false);
  });

  it.runIf(posix)('keeps a link through another link of the download that stays inside, and drops one that climbs out through it', async () => {
    write(PROD1, 'logs/src/index.js', 'js');
    fs.symlinkSync('src', at(PROD1, 'logs/lib'));
    fs.symlinkSync('lib/index.js', at(PROD1, 'logs/cur'));
    fs.symlinkSync('lib/../..', at(PROD1, 'logs/out'));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    expect(fs.readFileSync(path.join(picked, 'logs', 'cur'), 'utf8')).toBe('js');
    expect(fs.existsSync(path.join(picked, 'logs', 'out'))).toBe(false);
  });
});

// a source of chunks that stalls after them, as a stream over a stalled connection does, and records its return
function stalled(...parts: string[]): { readonly chunks: AsyncIterable<Uint8Array>; readonly returned: () => boolean } {
  let returned = false;
  const queue = parts.map((part) => Buffer.from(part));
  const iterator: AsyncIterator<Uint8Array> = {
    next: async () => {
      const next = queue.shift();
      return next ? { done: false, value: next } : new Promise<IteratorResult<Uint8Array>>(() => undefined);
    },
    return: async () => {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  return { chunks: { [Symbol.asyncIterator]: () => iterator }, returned: () => returned };
}

const statesOf = (transferId: number): string[] => progress.filter((update) => update.transferId === transferId).map((update) => update.state);

// a service whose notices open their details, which it collects
function withDetails(): string[][] {
  const shown: string[][] = [];
  service = new FileTransferService(deps({
    notify: async (severity, message, actions) => {
      notices.push({ severity, message, actions });
      return actions.includes('Show details') ? actions.indexOf('Show details') : undefined;
    },
    showDetails: async (_message, lines) => {
      shown.push([...lines]);
    },
  }));
  return shown;
}

async function walkOf(projectKey: string, relativePath: string): Promise<TransferEntry[]> {
  const entries: TransferEntry[] = [];
  for await (const page of hosts.get(projectKey)!.walk(projects.find((project) => project.key === projectKey)!, relativePath)) entries.push(...page);
  return entries;
}

function walkYields(projectKey: string, entries: readonly TransferEntry[]): void {
  vi.spyOn(hosts.get(projectKey)!, 'walk').mockImplementation(() => ({
    [Symbol.asyncIterator]: async function* walk() {
      yield entries;
    },
  }));
}

describe('moves and copies of folders', () => {
  it('removes every emptied source folder of a move between hosts, children first', async () => {
    write(PROD1, 'pkg/sub/file.txt', 'deep');
    expect(await run({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'pkg' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } })).toMatchObject({ state: 'done' });
    expect(read(PROD2, 'src/pkg/sub/file.txt')).toBe('deep');
    expect(fs.existsSync(at(PROD1, 'pkg'))).toBe(false);
  });

  it('copies a folder into the folder it is in as a copy beside it, without asking about its files', async () => {
    write(PROD1, 'src/lib/a.ts', 'a');
    write(PROD1, 'src/lib/b.ts', 'b');
    expect(await run({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/lib' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' }, keepBothWithItself: true })).toMatchObject({ state: 'done' });
    expect(questions).toEqual([]);
    expect(fs.readdirSync(at(PROD1, 'src')).sort()).toEqual(['lib', 'lib copy']);
    expect(fs.readdirSync(at(PROD1, 'src/lib copy')).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('tells the source of a move between hosts that its folders changed', async () => {
    const changed: FilesChanged[] = [];
    service = new FileTransferService(deps({ changed: (change) => changed.push(change) }));
    write(PROD1, 'src/deep/a.ts', 'a');
    await run({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/deep/a.ts' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    expect(changed.find((change) => change.projectKey === PROD1)?.relativeDirs).toEqual(['src/deep']);
  });

  it('names the project, never its key, when a project is copied into itself', async () => {
    expect(await service.start({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: '' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'refused' });
    expect(notices.map((notice) => notice.message)).toEqual(['Damocles can\'t copy \'p1\' into itself.']);
  });

  it('asks the destination about a merged folder\'s entries in chunks the host parser accepts', async () => {
    write(LOCAL, 'in/big/f0.txt', 'x');
    write(PROD1, 'src/big/keep.txt', 'kept');
    const real = await walkOf(LOCAL, 'in/big');
    walkYields(LOCAL, [real[0]!, ...Array.from({ length: CLASHES_CHUNK_NAMES + 5 }, (_, index) => ({ ...real[1]!, relativePath: `f${index}.txt` }))]);
    vi.spyOn(hosts.get(LOCAL)!, 'readFile').mockImplementation(async () => ({ ok: false, reason: 'missing' }));
    const dest = hosts.get(PROD1)!;
    const clashes = dest.clashes.bind(dest);
    const asked: number[] = [];
    vi.spyOn(dest, 'clashes').mockImplementation(async (project, dir, names) => {
      asked.push(names.length);
      return clashes(project, dir, names);
    });
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: LOCAL, relativePath: 'in/big' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    expect(asked).toEqual([1, CLASHES_CHUNK_NAMES, 5]);
  });
});

describe('what a move across file systems left', () => {
  it('lists the moved item itself for an entry of \'\', and counts the items it could not list', async () => {
    write(PROD1, 'src/pkg/a.ts', 'a');
    fs.mkdirSync(at(PROD1, 'lib'));
    const shown = withDetails();
    vi.spyOn(hosts.get(PROD1)!, 'move').mockImplementation(async () => ({ ok: true, left: ['', 'deep/x'], leftMore: 3 }));
    await run({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/pkg' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'lib' } });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toEqual(['pkg: it could not be copied', 'pkg/deep/x: it could not be copied', 'pkg: more items stayed where they were and are not listed: 3']);
  });
});

describe('host refusals in the summary', () => {
  it('lists each host reason in the user\'s language; only a failure without a reason keeps the system\'s text', async () => {
    for (const name of ['short', 'invalid', 'gone', 'outside', 'full', 'raw']) write(LOCAL, `in/${name}.txt`, name);
    const shown = withDetails();
    const results: Record<string, TransferResult> = {
      'short.txt': { ok: false, reason: 'incomplete', message: 'The source ended after 3 of 8 bytes' },
      'invalid.txt': { ok: false, reason: 'failed', code: 'EINVAL' },
      'gone.txt': { ok: false, reason: 'notFolder' },
      'outside.txt': { ok: false, reason: 'outside' },
      'full.txt': { ok: false, reason: 'failed', code: 'ENOSPC', message: 'ENOSPC: no space left on device, write' },
      'raw.txt': { ok: false, reason: 'failed', code: 'EIO', message: 'EIO: i/o error, write' },
    };
    vi.spyOn(hosts.get(PROD1)!, 'receiveFile').mockImplementation(async (_project, _dir, name) => results[name]!);
    await run({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect([...shown[0]!].sort()).toEqual([
      'in/full.txt: the disk is full',
      'in/gone.txt: it or its folder is no longer there',
      'in/invalid.txt: its size, time or link target cannot be stored there',
      'in/outside.txt: its folder now leads outside the destination folder',
      'in/raw.txt: EIO: i/o error, write',
      'in/short.txt: it changed during the copy',
    ]);
  });

  it('lists an entry the walk could not read with its error code', async () => {
    write(PROD1, 'logs/app.log', 'log');
    const real = await walkOf(PROD1, 'logs');
    walkYields(PROD1, [...real, { ...real[1]!, relativePath: 'broken', kind: 'other', size: 0, error: 'EIO' }, { ...real[1]!, relativePath: 'secret', kind: 'other', size: 0, error: 'EACCES' }]);
    const shown = withDetails();
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toEqual(['logs/broken: it could not be read (EIO)', 'logs/secret: permission denied']);
  });
});

describe('download summary', () => {
  it('reveals the name Keep both chose for the downloaded item', async () => {
    write(PROD1, 'logs/app.log', 'log');
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    fs.writeFileSync(path.join(picked, 'logs'), 'a file already named logs');
    const revealed: string[] = [];
    service = new FileTransferService(deps({
      notify: async (severity, message, actions) => {
        notices.push({ severity, message, actions });
        return 0;
      },
      reveal: async (absolutePath) => {
        revealed.push(absolutePath);
      },
    }));
    answers.push({ action: 0, checked: false });
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    expect(questions.map((question) => question.actions)).toEqual([['Keep both', 'Skip']]);
    await vi.waitFor(() => expect(revealed).toEqual([path.join(picked, 'logs copy')]));
    expect(fs.readFileSync(path.join(picked, 'logs copy', 'app.log'), 'utf8')).toBe('log');
  });
});

describe('links made within the copied item', () => {
  it('follows each again once every link landed, and lists one a later Replace made lead outside', async () => {
    service = new FileTransferService(deps({ target: (projectKey) => (projectKey === LOCAL ? { os: process.platform } : { os: 'linux', host: projectKey === PROD1 ? 'prod-1' : 'prod-2' }) }));
    write(PROD1, 'logs/app.log', 'log');
    const real = await walkOf(PROD1, 'logs');
    walkYields(PROD1, [...real, { ...real[1]!, relativePath: 'a', kind: 'link', size: 0, linkTarget: 'cur/..' }, { ...real[1]!, relativePath: 'b', kind: 'link', size: 0, linkTarget: 'app.log' }]);
    const dest = hosts.get(PROD2)!;
    vi.spyOn(dest, 'makeLink').mockImplementation(async () => ({ ok: true }));
    const verified: Array<[string, string]> = [];
    vi.spyOn(dest, 'verifyLink').mockImplementation(async (_project, relativePath, within) => {
      verified.push([relativePath, within]);
      return relativePath === 'src/logs/a' ? { ok: false, reason: 'outside' } : { ok: true };
    });
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    expect(verified).toEqual([['src/logs/a', 'src/logs'], ['src/logs/b', 'src/logs']]);
    expect(notices.at(-1)!.message).toBe('Copied 2 of 3 items to prod-2. 1 skipped');
  });
});

describe('a host whose Damocles server carries no transfers', () => {
  it('refuses up front with a notice naming the host, before any walk, question or row', async () => {
    service = new FileTransferService(deps({ transfers: (projectKey) => projectKey !== PROD1 }));
    write(LOCAL, 'in/a.ts', 'a');
    const walk = vi.spyOn(hosts.get(LOCAL)!, 'walk');
    expect(await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/a.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'refused' });
    expect(await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src' }], destination: { kind: 'download', folder: root } })).toEqual({ ok: false, reason: 'refused' });
    expect(notices.map((notice) => notice.message)).toEqual(Array(2).fill('The Damocles server on prod-1 is too old to copy files. Reconnect to update it.'));
    expect(walk).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
  });

  it('turns a refusal of the host\'s workspace during planning into the same notice', async () => {
    vi.spyOn(hosts.get(PROD1)!, 'walk').mockImplementation(() => {
      throw new TransfersUnsupportedError('ssh+one');
    });
    expect(await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src' }], destination: { kind: 'download', folder: root } })).toEqual({ ok: false, reason: 'refused' });
    expect(notices.map((notice) => notice.message)).toEqual(['The Damocles server on prod-1 is too old to copy files. Reconnect to update it.']);
    expect(statesOf(1)).toEqual(['preparing', 'failed']);
  });
});

describe('preparing', () => {
  it('shows the transfer at once, counting the items found while the walk runs, and Cancel ends it between pages', async () => {
    write(PROD1, 'src/a.ts', 'aaa');
    const real = await walkOf(PROD1, 'src');
    let release!: () => void;
    const gate = new Promise<void>((open) => { release = open; });
    let returned = false;
    let pages = 0;
    vi.spyOn(hosts.get(PROD1)!, 'walk').mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          pages += 1;
          if (pages === 2) await gate;
          return pages <= 2 ? { done: false, value: real } : { done: true, value: undefined };
        },
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    }));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    // past FILES_TRANSFER_PROGRESS_MS between every two updates
    let clock = 0;
    service = new FileTransferService(deps({ now: () => (clock += 1000) }));
    const started = service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src' }], destination: { kind: 'download', folder: picked } });
    await vi.waitFor(() => expect(pages).toBe(2));
    expect(progress[0]).toMatchObject({ transferId: 1, state: 'preparing', filesTotal: 0 });
    expect(progress.at(-1)).toMatchObject({ state: 'preparing', filesTotal: 1, bytesTotal: 3 });
    service.cancel(1);
    expect(statesOf(1).at(-1)).toBe('cancelled');
    release();
    expect(await started).toEqual({ ok: false, reason: 'cancelled' });
    expect(returned).toBe(true);
    expect(statesOf(1).filter((state) => state === 'cancelled')).toHaveLength(1);
    expect(fs.readdirSync(picked)).toEqual([]);
  });

  it('asks no question after a Cancel, and discards the answer of the one open then', async () => {
    write(LOCAL, 'in/app.ts', 'new');
    write(LOCAL, 'in/lib.ts', 'new');
    write(PROD1, 'src/app.ts', 'old');
    write(PROD1, 'src/lib.ts', 'old');
    service = new FileTransferService(deps({
      askChecked: async (question) => {
        questions.push(question);
        service.cancel(1);
        return REPLACE;
      },
    }));
    expect(await service.start({ op: 'copy', sources: ['app.ts', 'lib.ts'].map((name) => ({ kind: 'local' as const, path: at(LOCAL, `in/${name}`) })), destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } })).toEqual({ ok: false, reason: 'cancelled' });
    expect(questions).toHaveLength(1);
    expect(read(PROD1, 'src/app.ts')).toBe('old');
    expect(statesOf(1)).toEqual(['preparing', 'cancelled']);
  });
});

describe('cancel during a step', () => {
  it('ends the row at once while the source stalls, and the step still removes its part and returns the source', async () => {
    write(PROD1, 'logs/app.log', 'abcdefgh');
    const source = stalled('abcd');
    vi.spyOn(hosts.get(PROD1)!, 'readFile').mockImplementation(async () => ({ ok: true, size: 8, chunks: source.chunks }));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    const started = await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    if (!started.ok) throw new Error(started.reason);
    await vi.waitFor(() => expect(fs.readdirSync(path.join(picked, 'logs')).some(isPartName)).toBe(true));
    service.cancel(started.transferId);
    expect(await settled(started.transferId)).toMatchObject({ state: 'cancelled' });
    await service.cancelAll();
    expect(source.returned()).toBe(true);
    expect(fs.readdirSync(path.join(picked, 'logs'))).toEqual([]);
  });

  it('cancels a copy on one host through its signal', async () => {
    write(PROD1, 'src/huge.bin', 'x');
    fs.mkdirSync(at(PROD1, 'lib'));
    let seen: AbortSignal | undefined;
    vi.spyOn(hosts.get(PROD1)!, 'copy').mockImplementation(async (_from, _rel, _to, _dir, _name, _replace, signal) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('This operation was aborted'))));
    });
    const started = await service.start({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'src/huge.bin' }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'lib' } });
    if (!started.ok) throw new Error(started.reason);
    await vi.waitFor(() => expect(seen).toBeDefined());
    service.cancel(started.transferId);
    expect(await settled(started.transferId)).toMatchObject({ state: 'cancelled' });
    expect(seen!.aborted).toBe(true);
  });

  it('returns the source when the receiver refuses before it read a byte', async () => {
    write(PROD1, 'logs/app.log', 'abcdefgh');
    const source = stalled('abcdefgh');
    vi.spyOn(hosts.get(PROD1)!, 'readFile').mockImplementation(async () => ({ ok: true, size: 8, chunks: source.chunks }));
    vi.spyOn(hosts.get(LOCAL)!, 'receiveFile').mockImplementation(async () => ({ ok: false, reason: 'exists' }));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    await run({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    expect(source.returned()).toBe(true);
  });
});

describe('quit', () => {
  it('cancelAll stops every transfer, and settles once each removed the part it was writing', async () => {
    write(PROD1, 'logs/app.log', 'abcdefgh');
    const source = stalled('abcd');
    vi.spyOn(hosts.get(PROD1)!, 'readFile').mockImplementation(async () => ({ ok: true, size: 8, chunks: source.chunks }));
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    write(LOCAL, 'in/two.ts', 'two');
    const first = await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'download', folder: picked } });
    const second = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/two.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    if (!first.ok || !second.ok) throw new Error('refused');
    await vi.waitFor(() => expect(fs.readdirSync(path.join(picked, 'logs')).some(isPartName)).toBe(true));
    await service.cancelAll();
    expect(fs.readdirSync(path.join(picked, 'logs'))).toEqual([]);
    expect(statesOf(first.transferId).at(-1)).toBe('cancelled');
    expect(statesOf(second.transferId).at(-1)).toBe('cancelled');
  });
});

describe('links settled once the last link landed', () => {
  const linuxTargets = (): Partial<FileTransferDeps> => ({ target: (projectKey) => (projectKey === LOCAL ? { os: process.platform } : { os: 'linux', host: projectKey === PROD1 ? 'prod-1' : 'prod-2' }) });

  async function linksFrom(): Promise<void> {
    write(PROD1, 'logs/app.log', 'log');
    const real = await walkOf(PROD1, 'logs');
    walkYields(PROD1, [...real, { ...real[1]!, relativePath: 'a', kind: 'link', size: 0, linkTarget: 'cur/..' }, { ...real[1]!, relativePath: 'cur', kind: 'link', size: 0, linkTarget: '.' }]);
  }

  it('still follows every link made when Cancel comes during the link that changes where another leads', async () => {
    service = new FileTransferService(deps(linuxTargets()));
    await linksFrom();
    const dest = hosts.get(PROD2)!;
    vi.spyOn(dest, 'makeLink').mockImplementation(async (_project, _dir, name) => {
      if (name === 'cur') service.cancel(1);
      return { ok: true };
    });
    const verified: string[] = [];
    vi.spyOn(dest, 'verifyLink').mockImplementation(async (_project, relativePath) => {
      verified.push(relativePath);
      return { ok: true };
    });
    const started = await service.start({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    if (!started.ok) throw new Error(started.reason);
    expect(await settled(started.transferId)).toMatchObject({ state: 'cancelled' });
    expect(verified).toEqual(['src/logs/a', 'src/logs/cur']);
  });

  it('deletes a moved link\'s source only once its link passed, and keeps the source of one refused', async () => {
    service = new FileTransferService(deps(linuxTargets()));
    await linksFrom();
    const dest = hosts.get(PROD2)!;
    vi.spyOn(dest, 'makeLink').mockImplementation(async () => ({ ok: true }));
    vi.spyOn(dest, 'verifyLink').mockImplementation(async (_project, relativePath) => (relativePath === 'src/logs/a' ? { ok: false, reason: 'outside' } : { ok: true }));
    const deleted: string[] = [];
    const source = hosts.get(PROD1)!;
    vi.spyOn(source, 'deleteEntry').mockImplementation(async (_project, relativePath) => {
      deleted.push(relativePath);
      return { ok: true };
    });
    await run({ op: 'move', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    expect(deleted.sort()).toEqual(['logs/app.log', 'logs/cur']);
    expect(notices.at(-1)!.message).toBe('Moved 2 of 3 items to prod-2. 1 skipped');
  });

  it('lists a link whose check failed as not carried', async () => {
    service = new FileTransferService(deps(linuxTargets()));
    await linksFrom();
    const dest = hosts.get(PROD2)!;
    vi.spyOn(dest, 'makeLink').mockImplementation(async () => ({ ok: true }));
    vi.spyOn(dest, 'verifyLink').mockImplementation(async (_project, relativePath) => {
      if (relativePath === 'src/logs/a') throw new Error('the connection closed');
      return { ok: true };
    });
    await run({ op: 'copy', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs' }], destination: { kind: 'project', projectKey: PROD2, relativeDir: 'src' } });
    expect(notices.at(-1)!.message).toBe('Copied 2 of 3 items to prod-2. 1 skipped');
  });
});

describe('the project\'s next transfer after a Cancel', () => {
  it('waits until the cancelled step stopped writing', async () => {
    write(PROD1, 'logs/app.log', 'abcdefgh');
    write(LOCAL, 'in/next.ts', 'next');
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const order: string[] = [];
    const local = hosts.get(LOCAL)!;
    const receive = local.receiveFile.bind(local);
    vi.spyOn(local, 'receiveFile').mockImplementation(async (...args) => {
      await finished;
      order.push('cancelled step settled');
      return receive(...args);
    });
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    const first = await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: PROD1, relativePath: 'logs/app.log' }], destination: { kind: 'download', folder: picked } });
    if (!first.ok) throw new Error(first.reason);
    await vi.waitFor(() => expect(statesOf(first.transferId)).toContain('running'));
    service.cancel(first.transferId);
    await settled(first.transferId);
    const second = await service.start({ op: 'copy', sources: [{ kind: 'local', path: at(LOCAL, 'in/next.ts') }], destination: { kind: 'project', projectKey: PROD1, relativeDir: 'src' } });
    if (!second.ok) throw new Error(second.reason);
    // a run starts with its 'running' update, in the turn its queue lets it
    await new Promise((resolve) => setImmediate(resolve));
    expect(statesOf(second.transferId)).toEqual(['preparing', 'queued']);
    finish();
    expect(await settled(second.transferId)).toMatchObject({ state: 'done' });
    expect(order).toEqual(['cancelled step settled']);
    expect(read(PROD1, 'src/next.ts')).toBe('next');
  });
});
