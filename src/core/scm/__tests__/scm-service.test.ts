import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FileWatcher } from '../../../platform/file-watcher';
import type { GitCall, GitCloner, GitRunner } from '../git-runner';
import { ScmService, type ScmQuestion } from '../scm-service';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import type { FolderCheck } from '../../workspace-folders/folder-presence-probe';
import type { TrustChange } from '../../../platform/trust-service';

const sessionJobs = vi.hoisted(() => ({ created: [] as Array<{ id: number; disposed: number; dispose: () => void }> }));

// The real one is a kernel job or a sentinel process; this records which handle the service made and when it closed.
vi.mock('../../process-launcher', () => ({
  processLauncher: () => ({
    createSessionJob: () => {
      const job = { id: sessionJobs.created.length + 1, disposed: 0, dispose: () => void job.disposed++ };
      sessionJobs.created.push(job);
      return job;
    },
  }),
}));

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-scm-service-')));
const inner = path.join(sandbox, 'inner');
fs.mkdirSync(path.join(inner, 'folder'), { recursive: true });

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// A presence probe answering as `answer` does; admit() fires the hung gate's admit and answerLate() a late stat's answer.
function probeOf(answer: (folder: string) => Promise<FolderCheck>) {
  const admitted = new Set<() => void>();
  const late = new Set<(folder: string) => void>();
  return {
    presence: answer,
    onDidAdmit: (listener: () => void) => {
      admitted.add(listener);
      return { dispose: () => { admitted.delete(listener); } };
    },
    onDidAnswerLate: (listener: (folder: string) => void) => {
      late.add(listener);
      return { dispose: () => { late.delete(listener); } };
    },
    admit: () => { for (const listener of [...admitted]) listener(); },
    answerLate: (folder: string) => { for (const listener of [...late]) listener(folder); },
  };
}

const inert: FileWatcher = { ready: Promise.resolve(), onDidCreate: () => ({ dispose: () => undefined }), onDidChange: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined };

const inertWatchers = { watch: () => inert, watchWorkspace: () => inert, onDidRenameFiles: () => ({ dispose: () => undefined }) };
const noSettings = { get: () => undefined, inspect: () => ({}), update: async () => undefined, onDidChange: () => ({ dispose: () => undefined }), scopeFile: () => undefined } as never;

// A project whose 'deep' folder holds a repository git refuses for dubious ownership until safe.directory lists it.
function unsafeDeep(trusted: (folder: string) => boolean, onAsk: (question: ScmQuestion) => void = () => undefined, leaf = 'deep') {
  const project = path.join(sandbox, 'unsafe-project');
  const deep = path.join(project, 'a', 'b', leaf);
  fs.mkdirSync(deep, { recursive: true });
  const owner = deep.replace(/\\/g, '/');
  const calls: GitCall[] = [];
  let safe = false;
  const runner: GitRunner & GitCloner = {
    clone: () => Promise.reject(new Error('This test clones nothing')),
    git: { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 0 } },
    envFor: () => ({}),
    run: async (call) => {
      calls.push(call);
      if (call.args[0] === 'config') {
        safe = true;
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
      }
      if (path.resolve(call.cwd) === deep && call.args[1] === '--show-toplevel') {
        return safe
          ? { exitCode: 0, stdout: Buffer.from(`${deep}\n${path.join(deep, '.git')}\n.git\n`), stderr: '' }
          : { exitCode: 128, stdout: Buffer.alloc(0), stderr: `fatal: detected dubious ownership in repository at '${owner}'\n\tgit config --global --add safe.directory ${owner}\n` };
      }
      if (call.args[0] === 'status') return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
      return { exitCode: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository\n' };
    },
  };
  const service = new ScmService({
    runner,
    trust: { isTrusted: trusted, onDidChangeTrust: () => ({ dispose: () => undefined }), requestTrust: async () => true },
    watchers: inertWatchers,
    settings: noSettings,
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined } as never,
    ask: async (question) => (onAsk(question), 0),
    notify: async () => undefined,
    trash: async () => undefined,
    log: () => undefined,
    presence: probeOf(async () => 'present'),
  });
  return { service, project, deep, owner, calls };
}

describe('scm service', () => {
  it('refuses git work without git in the words a view renders', async () => {
    const service = new ScmService({
      runner: undefined,
      trust: { isTrusted: () => true, onDidChangeTrust: () => ({ dispose: () => undefined }), requestTrust: async () => true },
      watchers: inertWatchers,
      settings: noSettings,
      globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined } as never,
      ask: async () => undefined,
      notify: async () => undefined,
      trash: async () => undefined,
      log: () => undefined,
      presence: probeOf(async () => 'present'),
    });
    service.setProjects([{ key: 'p', path: inner }]);
    const refusal = await service.init('p').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(LocalizedError);
    expect((refusal as LocalizedError).text).toEqual({ message: 'Git was not found' });
    service.dispose();
  });

  it('hands its one session job to every git call and closes it on dispose', async () => {
    const before = sessionJobs.created.length;
    const { service, project, deep, owner, calls } = unsafeDeep(() => true);
    expect(sessionJobs.created.length).toBe(before + 1);
    const job = sessionJobs.created.at(-1)!;
    service.setProjects([{ key: 'p', path: project }]);
    for (let i = 0; i < 100 && service.view('p')!.state === 'loading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.openFolder('p', deep)).toBe('unsafe');
    expect(await service.trustUnsafe('p', owner)).toBe(true);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((call) => call.session === job)).toBe(true);
    expect(job.disposed).toBe(0);
    service.dispose();
    expect(job.disposed).toBe(1);
  });

  it('opens an unsafe repository Open Repository found below the scan depth once the user lets safe.directory list it', async () => {
    const { service, project, deep, owner, calls } = unsafeDeep(() => true);
    service.setProjects([{ key: 'p', path: project }]);
    for (let i = 0; i < 100 && service.view('p')!.state === 'loading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.openFolder('p', deep)).toBe('unsafe');
    // a rediscovery keeps it listed
    await service.reopen('p', []);
    expect(service.view('p')!.unsafe).toEqual([owner]);
    expect(await service.trustUnsafe('p', owner)).toBe(true);
    const config = calls.find((call) => call.args[0] === 'config')!;
    expect(config.args).toEqual(['config', '--global', '--add', 'safe.directory', owner]);
    expect(config.cwd).toBe(os.homedir());
    expect(service.view('p')!.repos.map((repo) => repo.root)).toEqual([deep]);
    expect(service.view('p')!.unsafe).toEqual([]);
    service.dispose();
  });

  it('shows the control and bidi characters of the unsafe path in the safe.directory question as escapes', async () => {
    const questions: ScmQuestion[] = [];
    const { service, project, deep, owner } = unsafeDeep(() => true, (question) => questions.push(question), 'evil\u202Etxt');
    service.setProjects([{ key: 'p', path: project }]);
    for (let i = 0; i < 100 && service.view('p')!.state === 'loading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.openFolder('p', deep)).toBe('unsafe');
    expect(await service.trustUnsafe('p', owner)).toBe(true);
    expect(englishText(questions[0]!.detail!)).toContain('evil\\u{202E}txt');
    expect(englishText(questions[0]!.detail!)).not.toContain('\u202E');
    service.dispose();
  });

  it('refuses to list a path in safe.directory that lies in a registered project not trusted, registered before or during the question', async () => {
    let declined = '';
    let registerDuringQuestion = false;
    const { service, project, deep, owner, calls } = unsafeDeep(
      (folder) => path.resolve(folder) !== declined,
      () => {
        if (registerDuringQuestion) service.setProjects([{ key: 'p', path: project }, { key: 'b', path: path.dirname(deep) }]);
      },
    );
    declined = path.dirname(deep);
    service.setProjects([{ key: 'p', path: project }]);
    for (let i = 0; i < 100 && service.view('p')!.state === 'loading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.openFolder('p', deep)).toBe('unsafe');
    registerDuringQuestion = true;
    await expect(service.trustUnsafe('p', owner)).rejects.toThrow('That folder belongs to a project you have not trusted, so source control runs no git there.');
    expect(calls.some((call) => call.args[0] === 'config')).toBe(false);
    await expect(service.trustUnsafe('p', owner)).rejects.toThrow('That folder belongs to a project you have not trusted');
    service.dispose();
  });

  it('sends an unsafe repository above the project through the parent question before any safe.directory offer, from Open Repository too', async () => {
    const owner = sandbox.replace(/\\/g, '/');
    const calls: GitCall[] = [];
    const runner: GitRunner & GitCloner = {
      clone: () => Promise.reject(new Error('This test clones nothing')),
      git: { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 0 } },
      envFor: () => ({}),
      run: async (call) => {
        calls.push(call);
        return { exitCode: 128, stdout: Buffer.alloc(0), stderr: `fatal: detected dubious ownership in repository at '${owner}'\n\tgit config --global --add safe.directory ${owner}\n` };
      },
    };
    const questions: ScmQuestion[] = [];
    const notices: string[] = [];
    const values = new Map<string, unknown>();
    const service = new ScmService({
      runner,
      trust: { isTrusted: () => true, onDidChangeTrust: () => ({ dispose: () => undefined }), requestTrust: async () => true },
      watchers: { watch: () => inert, watchWorkspace: () => inert, onDidRenameFiles: () => ({ dispose: () => undefined }) },
      settings: { get: () => undefined, inspect: () => ({}), update: async () => undefined, onDidChange: () => ({ dispose: () => undefined }), scopeFile: () => undefined } as never,
      globalState: { get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback), update: async (key: string, value: unknown) => void values.set(key, value) } as never,
      ask: async (question) => (questions.push(question), undefined),
      notify: async (message) => (notices.push(englishText(message)), undefined),
      trash: async () => undefined,
      log: () => undefined,
      presence: probeOf(async () => 'present'),
    });
    service.setProjects([{ key: 'p', path: inner }]);
    for (let i = 0; i < 100 && notices.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notices).toHaveLength(1);
    expect(service.view('p')!.unsafe).toEqual([]);
    expect(service.view('p')!.parents).toEqual([owner]);

    expect(await service.openFolder('p', path.join(inner, 'folder'))).toBe('parent');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.defaultAction).toBeUndefined();
    expect(service.view('p')!.unsafe).toEqual([]);
    expect(calls.every((call) => call.args[0] === 'rev-parse')).toBe(true);
    service.dispose();
  });
});

// A project whose presence and trust the test sets, over a runner that records each git call and finds no repository anywhere.
function absentProject(presence: () => Promise<FolderCheck>, realpath?: (folder: string) => Promise<string>, trusted: () => boolean = () => true) {
  const calls: GitCall[] = [];
  const runner: GitRunner & GitCloner = {
    clone: () => Promise.reject(new Error('This test clones nothing')),
    git: { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 0 } },
    envFor: () => ({}),
    run: async (call) => {
      calls.push(call);
      return { exitCode: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository\n' };
    },
  };
  const trustListeners = new Set<(change: TrustChange) => void>();
  const probe = probeOf(presence);
  const service = new ScmService({
    runner,
    trust: {
      isTrusted: () => trusted(),
      onDidChangeTrust: (listener) => {
        trustListeners.add(listener);
        return { dispose: () => { trustListeners.delete(listener); } };
      },
      requestTrust: async () => true,
    },
    watchers: inertWatchers,
    settings: noSettings,
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined } as never,
    ask: async () => undefined,
    notify: async () => undefined,
    trash: async () => undefined,
    log: () => undefined,
    presence: probe,
    ...(realpath ? { realpath } : {}),
  });
  const trustChanged = (change: TrustChange): void => { for (const listener of [...trustListeners]) listener(change); };
  return { service, calls, probe, trustChanged };
}

async function settledView(service: ScmService, projectKey: string) {
  for (let i = 0; i < 100 && service.view(projectKey)!.state === 'loading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return service.view(projectKey)!;
}

describe('a project whose folder is not there', () => {
  const gone = path.join(sandbox, 'gone');

  it('shows as absent and missing, with no git run and nothing to initialize', async () => {
    const { service, calls } = absentProject(async () => 'missing');
    service.setProjects([{ key: 'p', path: gone }]);
    expect(await settledView(service, 'p')).toMatchObject({ state: 'absent', presence: 'missing', repos: [] });
    expect(calls).toEqual([]);
    service.dispose();
  });

  it('shows an unavailable folder as such without waiting on its realpath, which a share that does not answer holds', async () => {
    const { service, calls } = absentProject(async () => 'unavailable', () => new Promise<string>(() => undefined));
    service.setProjects([{ key: 'p', path: gone }]);
    expect(await settledView(service, 'p')).toMatchObject({ state: 'absent', presence: 'unavailable' });
    expect(calls).toEqual([]);
    service.dispose();
  });

  it('shows a folder that went away while discovery ran as absent, not as a folder with no repository', async () => {
    const answers: FolderCheck[] = ['present', 'missing'];
    const { service, calls } = absentProject(async () => answers.shift() ?? 'missing');
    service.setProjects([{ key: 'p', path: gone }]);
    expect(await settledView(service, 'p')).toMatchObject({ state: 'absent', presence: 'missing' });
    expect(calls).toEqual([]);
    service.dispose();
  });

  it('is discovered again on rediscover once the folder is back', async () => {
    let presence: FolderCheck = 'missing';
    const { service } = absentProject(async () => presence);
    service.setProjects([{ key: 'p', path: inner }]);
    expect((await settledView(service, 'p')).state).toBe('absent');
    presence = 'present';
    service.rediscover('p');
    for (let i = 0; i < 100 && service.view('p')!.state === 'absent'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.view('p')).toMatchObject({ state: 'noRepository', repos: [] });
    expect(service.view('p')!.presence).toBeUndefined();
    service.rediscover('unlisted');
    service.dispose();
  });

  it('labels a project with no repository absent on rediscover once its folder is gone, running no git', async () => {
    let presence: FolderCheck = 'present';
    const { service, calls } = absentProject(async () => presence);
    service.setProjects([{ key: 'p', path: inner }]);
    expect((await settledView(service, 'p')).state).toBe('noRepository');
    const ran = calls.length;
    // a folder that is there keeps its view
    service.rediscover('p');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.view('p')!.state).toBe('noRepository');
    presence = 'missing';
    service.rediscover('p');
    for (let i = 0; i < 100 && service.view('p')!.state !== 'absent'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.view('p')).toMatchObject({ state: 'absent', presence: 'missing', repos: [] });
    expect(calls).toHaveLength(ran);
    service.dispose();
  });

  it('leaves a project loading while the hung gate starts no stat, and discovers it once the gate admits again', async () => {
    let presence: FolderCheck = 'unchecked';
    const { service, calls, probe } = absentProject(async () => presence);
    service.setProjects([{ key: 'p', path: inner }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.view('p')).toMatchObject({ state: 'loading', repos: [] });
    expect(service.view('p')!.presence).toBeUndefined();
    expect(calls).toEqual([]);
    presence = 'present';
    probe.admit();
    expect((await settledView(service, 'p')).state).toBe('noRepository');
    service.dispose();
  });

  it('discovers an absent project again when a stat its check gave up on finds the folder', async () => {
    let presence: FolderCheck = 'unavailable';
    const { service, probe } = absentProject(async () => presence);
    service.setProjects([{ key: 'p', path: inner }]);
    expect(await settledView(service, 'p')).toMatchObject({ state: 'absent', presence: 'unavailable' });
    presence = 'present';
    probe.answerLate(path.join(sandbox, 'elsewhere'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.view('p')!.state).toBe('absent');
    probe.answerLate(inner);
    for (let i = 0; i < 100 && service.view('p')!.state === 'absent'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.view('p')!.state).toBe('noRepository');
    service.dispose();
  });

  it('refuses Initialize Repository in the words a view renders, before any git runs', async () => {
    let presence: FolderCheck = 'missing';
    const { service, calls } = absentProject(async () => presence);
    service.setProjects([{ key: 'p', path: gone }]);
    await settledView(service, 'p');
    const missing = await service.init('p').catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(LocalizedError);
    expect(englishText((missing as LocalizedError).text)).toBe(`The folder ${gone} was not found. It may have been moved, renamed or deleted.`);
    presence = 'unavailable';
    const unavailable = await service.init('p').catch((err: unknown) => err);
    expect(englishText((unavailable as LocalizedError).text)).toBe(`The folder ${gone} can't be reached: its drive, share or WSL distro does not answer.`);
    expect(calls).toEqual([]);
    service.dispose();
  });

  it('refuses Initialize Repository as busy when the hung gate still refuses the check once it admits, running no git', async () => {
    const asked: string[] = [];
    const { service, calls, probe } = absentProject(async () => {
      asked.push('presence');
      return 'unchecked';
    });
    service.setProjects([{ key: 'p', path: gone }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    asked.length = 0;
    const init = service.init('p').catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toHaveLength(1);
    probe.admit();
    const busy = await init;
    expect(busy).toBeInstanceOf(LocalizedError);
    expect(englishText((busy as LocalizedError).text)).toBe(`Damocles can't check the folder ${gone} right now: its drive checks are busy. Try again in a moment.`);
    expect(calls).toEqual([]);
    expect(service.view('p')!.state).toBe('loading');
    service.dispose();
  });
});

describe('a project whose trust is taken back', () => {
  it('shows the Trust card and runs no more git once a revoke takes the trust a grant gave', async () => {
    let trusted = false;
    const { service, calls, trustChanged } = absentProject(async () => 'present', undefined, () => trusted);
    service.setProjects([{ key: 'p', path: inner }]);
    expect((await settledView(service, 'p')).state).toBe('untrusted');
    trusted = true;
    trustChanged({ granted: [inner], revoked: [] });
    for (let i = 0; i < 100 && service.view('p')!.state !== 'noRepository'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.view('p')!.state).toBe('noRepository');
    trusted = false;
    trustChanged({ granted: [], revoked: [inner] });
    expect(service.view('p')).toMatchObject({ state: 'untrusted', repos: [] });
    const ran = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(ran);
    service.dispose();
  });

  // a daemon client's attach can add keys with a change that names no folder
  it('discovers a project trusted now on a change that names no folder', async () => {
    let trusted = false;
    const { service, trustChanged } = absentProject(async () => 'present', undefined, () => trusted);
    service.setProjects([{ key: 'p', path: inner }]);
    expect((await settledView(service, 'p')).state).toBe('untrusted');
    trusted = true;
    trustChanged({ granted: [], revoked: [] });
    for (let i = 0; i < 100 && service.view('p')!.state !== 'noRepository'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.view('p')!.state).toBe('noRepository');
    service.dispose();
  });

  it('makes a discovery in flight stale, so it never shows the project as discovered', async () => {
    let trusted = true;
    let answer!: (presence: FolderCheck) => void;
    const { service, calls, trustChanged } = absentProject(() => new Promise<FolderCheck>((resolve) => { answer = resolve; }), undefined, () => trusted);
    service.setProjects([{ key: 'p', path: inner }]);
    await vi.waitFor(() => expect(answer).toBeDefined());
    trusted = false;
    trustChanged({ granted: [], revoked: [] });
    expect(service.view('p')!.state).toBe('untrusted');
    answer('present');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.view('p')!.state).toBe('untrusted');
    expect(calls).toEqual([]);
    service.dispose();
  });
});
