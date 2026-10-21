import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll } from 'vitest';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../../platform/file-watcher';
import type { Memento } from '../../../platform/key-value-state';
import type { SettingsChange, SettingsStore } from '../../../platform/settings-store';
import type { TrustService } from '../../../platform/trust-service';
import type { AskpassServer } from '../askpass/askpass-server';
import { createGitRunner, type GitCloner, type GitRunner } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { ScmService, type ScmQuestion } from '../scm-service';

// Real git in temp folders for the source control engine tests: the sandbox, fakes of the platform services and a harness.

function findGit(): string | undefined {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export const GIT_PATH = findGit();
export const HAS_GIT = GIT_PATH !== undefined;
const TMP_BASE = HAS_GIT ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir();

export let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];

export function git(args: string[], cwd: string): string {
  return execFileSync(GIT_PATH!, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

export function folder(name: string): string {
  const dir = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  return fs.realpathSync.native(dir);
}

export function makeRepo(dir: string, identity = true): string {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], dir);
  if (identity) {
    git(['config', 'user.email', 'tests@damocles.invalid'], dir);
    git(['config', 'user.name', 'Damocles Tests'], dir);
  }
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(path.join(dir, 'a.txt'), 'one\n');
  git(['add', '.'], dir);
  git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'first'], dir);
  return fs.realpathSync.native(dir);
}

export class FakeTrust implements TrustService {
  readonly trusted = new Set<string>();
  private readonly listeners = new Set<(folders: readonly string[]) => void>();
  isTrusted(folderPath: string): boolean {
    return this.trusted.has(path.resolve(folderPath).toLowerCase());
  }
  onDidGrantTrust(cb: (folderPaths: readonly string[]) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  async requestTrust(folderPath: string): Promise<boolean> {
    this.grant(folderPath);
    return true;
  }
  revoke(folderPath: string): void {
    this.trusted.delete(path.resolve(folderPath).toLowerCase());
  }
  grant(folderPath: string): void {
    this.trusted.add(path.resolve(folderPath).toLowerCase());
    for (const listener of this.listeners) listener([folderPath]);
  }
}

export class FakeSettings implements SettingsStore {
  readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<(change: SettingsChange) => void>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  inspect<T>(): { defaultValue?: T } {
    return {};
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    for (const listener of this.listeners) listener({ affects: (candidate) => candidate === key || key.startsWith(`${candidate}.`) });
  }
  onDidChange(_section: string, cb: (change: SettingsChange) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  scopeFile(): undefined {
    return undefined;
  }
}

export class MapMemento implements Memento {
  readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.map.has(key) ? structuredClone(this.map.get(key)) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}

const inertWatcher: FileWatcher = { onDidCreate: () => ({ dispose: () => undefined }), onDidChange: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined };
export const watchers: FileWatcherFactory = { watch: () => inertWatcher, watchWorkspace: () => inertWatcher, onDidRenameFiles: () => ({ dispose: () => undefined }) };

export interface Harness {
  readonly service: ScmService;
  readonly trust: FakeTrust;
  readonly settings: FakeSettings;
  readonly state: MapMemento;
  readonly log: string[];
  // the service's own log lines
  readonly serviceLog: string[];
  readonly questions: ScmQuestion[];
  readonly notices: string[];
  noticeAnswers: Array<string | undefined>;
  // every path handed to the trash, in order
  readonly trashed: string[];
  // where the default trash moved each of those, same order
  readonly bin: string[];
  answers: Array<number | undefined>;
}

export function harness(opts: { trusted?: readonly string[]; state?: MapMemento; settings?: FakeSettings; runner?: (GitRunner & GitCloner) | null; realpath?: (folder: string) => Promise<string>; trash?: (absolute: string) => Promise<void>; askpass?: AskpassServer; watchers?: FileWatcherFactory } = {}): Harness {
  const trust = new FakeTrust();
  for (const dir of opts.trusted ?? []) trust.trusted.add(path.resolve(dir).toLowerCase());
  const log: string[] = [];
  const version = parseGitVersion(git(['--version'], sandbox))!;
  const runner = opts.runner === null ? undefined : opts.runner ?? createGitRunner({ git: { path: GIT_PATH!, version }, log: { appendLine: (line) => log.push(line) }, isTrusted: (project) => trust.isTrusted(project) });
  const settings = opts.settings ?? new FakeSettings();
  const state = opts.state ?? new MapMemento();
  const h: Harness = {
    trust,
    settings,
    state,
    log,
    serviceLog: [],
    questions: [],
    notices: [],
    noticeAnswers: [],
    trashed: [],
    bin: [],
    answers: [],
    service: undefined as unknown as ScmService,
  };
  (h as { service: ScmService }).service = new ScmService({
    runner,
    trust,
    watchers: opts.watchers ?? watchers,
    settings,
    globalState: state,
    ask: async (question) => {
      h.questions.push(question);
      return h.answers.shift();
    },
    notify: async (message) => {
      h.notices.push(message);
      return h.noticeAnswers.shift();
    },
    trash: async (absolute) => {
      h.trashed.push(absolute);
      if (opts.trash) return opts.trash(absolute);
      const kept = path.join(fs.mkdtempSync(path.join(sandbox, 'bin-')), path.basename(absolute));
      fs.renameSync(absolute, kept);
      h.bin.push(kept);
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    log: (line) => h.serviceLog.push(line),
    ...(opts.realpath ? { realpath: opts.realpath } : {}),
    ...(opts.askpass ? { askpass: opts.askpass } : {}),
  });
  return h;
}

export async function waitFor<T>(read: () => T | undefined | false, label = 'condition'): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export const viewOf = (h: Harness, key = 'p') => h.service.view(key)!;
export const ready = (h: Harness, count = 1, key = 'p') => waitFor(() => viewOf(h, key).state === 'ready' && viewOf(h, key).repos.length >= count && viewOf(h, key), 'ready');
export const statusOf = (h: Harness, repoId: string) => h.service.snapshot(repoId)?.status;

// The repository's status after the given action, once a status that ran after it landed.
export async function freshStatus(h: Harness, repoId: string, action?: () => Promise<unknown>) {
  await waitFor(() => statusOf(h, repoId), 'a first status');
  if (action) await action();
  // a status already queued may predate the action; the refresh's run starts after it
  const before = statusOf(h, repoId);
  h.service.refresh(repoId);
  return waitFor(() => {
    const now = statusOf(h, repoId);
    return now !== undefined && now !== before && now;
  }, 'status');
}

// The sandbox, with git configuration isolated from the user's, for one test file.
export function useGitSandbox(): void {
  beforeAll(async () => {
    if (!HAS_GIT) return;
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_BASE, 'dam-scm-')));
    // The POSIX session job starts the sentinel from the platform's worker bundle, built here so no prior build is needed.
    const appRoot = path.join(sandbox, 'app');
    if (process.platform !== 'win32') {
      await build({
        entryPoints: [path.resolve(__dirname, '..', '..', 'pi-session', 'tools', 'shell-sentinel.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        outfile: path.join(appRoot, 'dist', 'sentinel.js'),
        logLevel: 'silent',
      });
    }
    installFakePlatform({ appRoot });
    const neutral = path.join(sandbox, 'neutral.gitconfig');
    fs.writeFileSync(neutral, '[protocol "file"]\n\tallow = always\n', 'utf8');
    for (const key of ISOLATED) savedEnv[key] = process.env[key];
    for (const key of ISOLATED) delete process.env[key];
    process.env['GIT_CONFIG_GLOBAL'] = neutral;
    process.env['GIT_CONFIG_SYSTEM'] = neutral;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CEILING_DIRECTORIES'] = sandbox;
  });

  afterAll(() => {
    if (!HAS_GIT) return;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
}

// On Windows another process holds the file open without sharing delete, as a running git holds its lock.
export async function unremovable(file: string): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const dir = path.dirname(file);
    const mode = fs.statSync(dir).mode & 0o777;
    fs.chmodSync(dir, 0o555);
    return async () => fs.chmodSync(dir, mode);
  }
  const shell = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`;
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('held')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`the holder exited with ${code}`)));
  });
  return () =>
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
}

// Points repo's core.fsmonitor at a script that appends to marker, so a test sees whether git ran repository-controlled code.
export function armFsmonitor(repo: string, marker: string): void {
  const hook = `${marker}.js`;
  fs.writeFileSync(hook, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`, 'utf8');
  git(['config', 'core.fsmonitor', `"${process.execPath.replace(/\\/g, '/')}" "${hook.replace(/\\/g, '/')}"`], repo);
}
