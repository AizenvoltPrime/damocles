import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FileWatcher } from '../../../platform/file-watcher';
import type { GitCall, GitRunner } from '../git-runner';
import { ScmService, type ScmQuestion } from '../scm-service';

const sessionJobs = vi.hoisted(() => ({ created: [] as Array<{ disposed: number; dispose: () => void }> }));

// The real one is a kernel job or a sentinel process; this records which handle the service made and when it closed.
vi.mock('../../pi-session/tools/process-tree', () => ({
  createShellSessionJob: () => {
    const job = { disposed: 0, dispose: () => void job.disposed++ };
    sessionJobs.created.push(job);
    return job;
  },
}));

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-scm-service-')));
const inner = path.join(sandbox, 'inner');
fs.mkdirSync(path.join(inner, 'folder'), { recursive: true });

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const inert: FileWatcher = { onDidCreate: () => ({ dispose: () => undefined }), onDidChange: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined };

const inertWatchers = { watch: () => inert, watchWorkspace: () => inert, onDidRenameFiles: () => ({ dispose: () => undefined }) };
const noSettings = { get: () => undefined, inspect: () => ({}), update: async () => undefined, onDidChange: () => ({ dispose: () => undefined }), scopeFile: () => undefined } as never;

// A project whose 'deep' folder holds a repository git refuses for dubious ownership until safe.directory lists it.
function unsafeDeep(trusted: (folder: string) => boolean, onAsk: () => void = () => undefined) {
  const project = path.join(sandbox, 'unsafe-project');
  const deep = path.join(project, 'a', 'b', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  const owner = deep.replace(/\\/g, '/');
  const calls: GitCall[] = [];
  let safe = false;
  const runner: GitRunner = {
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
    trust: { isTrusted: trusted, onDidGrantTrust: () => ({ dispose: () => undefined }), requestTrust: async () => true },
    watchers: inertWatchers,
    settings: noSettings,
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined } as never,
    ask: async () => (onAsk(), 0),
    notify: async () => undefined,
    trash: async () => undefined,
    t: (message) => message,
    log: () => undefined,
  });
  return { service, project, deep, owner, calls };
}

describe('scm service', () => {
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
    const runner: GitRunner = {
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
      trust: { isTrusted: () => true, onDidGrantTrust: () => ({ dispose: () => undefined }), requestTrust: async () => true },
      watchers: { watch: () => inert, watchWorkspace: () => inert, onDidRenameFiles: () => ({ dispose: () => undefined }) },
      settings: { get: () => undefined, inspect: () => ({}), update: async () => undefined, onDidChange: () => ({ dispose: () => undefined }), scopeFile: () => undefined } as never,
      globalState: { get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback), update: async (key: string, value: unknown) => void values.set(key, value) } as never,
      ask: async (question) => (questions.push(question), undefined),
      notify: async (message) => (notices.push(message), undefined),
      trash: async () => undefined,
      t: (message) => message,
      log: () => undefined,
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
