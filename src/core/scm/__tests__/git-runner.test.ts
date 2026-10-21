import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KillOptions, Launcher, SpawnSpec } from '../../process-launcher';
import { createGitRunner, gitAtLeast, gitEnv, GitOutputTooLargeError, GitQueueDisposedError, isSafeRevision, RepoQueue, revision, type GitCall } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { GitError, GitUntrustedError, redactUrls } from '../errors';

interface Launched {
  readonly spec: SpawnSpec;
  readonly stdin: string[];
  readonly kills: KillOptions[];
  finish(code: number | null, stdout?: string | Buffer, stderr?: string | Buffer): void;
  // the start failed: the pid and the exit reject at once
  failStart(err: Error): void;
  // the process started and its launcher worker died before it closed
  die(err: Error): void;
}

// Recorded rather than run; a killed process closes with no exit code, as a signalled one does.
function fakeLauncher(): { launched: Launched[]; launcher: Launcher } {
  const launched: Launched[] = [];
  const launcher: Launcher = {
    launch(spec) {
      const listeners: Record<'stdout' | 'stderr', Array<(chunk: Buffer) => void>> = { stdout: [], stderr: [] };
      let exit: (value: { code: number | null; signal: null }) => void = () => undefined;
      let failExit: (err: Error) => void = () => undefined;
      let close: () => void = () => undefined;
      let started: (pid: number) => void = () => undefined;
      let failPid: (err: Error) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: null }>((resolve, reject) => {
        exit = resolve;
        failExit = reject;
      });
      const closed = new Promise<void>((resolve) => (close = resolve));
      const pid = new Promise<number>((resolve, reject) => {
        started = resolve;
        failPid = reject;
      });
      const stdin: string[] = [];
      const kills: KillOptions[] = [];
      const finish = (code: number | null, out: string | Buffer = '', err: string | Buffer = ''): void => {
        started(4242);
        setImmediate(() => {
          if (out.length > 0) for (const listener of listeners.stdout) listener(Buffer.from(out));
          if (err.length > 0) for (const listener of listeners.stderr) listener(Buffer.from(err));
          exit({ code, signal: null });
          close();
        });
      };
      const failStart = (err: Error): void => {
        failPid(err);
        failExit(err);
      };
      const die = (err: Error): void => {
        started(4242);
        failExit(err);
      };
      launched.push({ spec, stdin, kills, finish, failStart, die });
      const text = (chunk: string | Uint8Array): string => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return {
        pid,
        onData: (stream, listener) => void listeners[stream].push(listener),
        write: (chunk) => {
          stdin.push(text(chunk));
          return Promise.resolve();
        },
        end: (chunk) => {
          if (chunk !== undefined) stdin.push(text(chunk));
        },
        exited,
        closed,
        kill: (options = {}) => {
          kills.push(options);
          finish(null);
        },
      };
    },
    createSessionJob: () => ({ id: 7, dispose: () => undefined }),
    dispose: async () => undefined,
  };
  return { launched, launcher };
}

const GIT = { path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: { major: 2, minor: 45, patch: 1 } };

function runner(trusted = true) {
  const fake = fakeLauncher();
  const lines: string[] = [];
  const instance = createGitRunner({ git: GIT, log: { appendLine: (line) => lines.push(line) }, isTrusted: () => trusted, launcher: fake.launcher, now: () => 0 });
  return { spawned: fake.launched, lines, instance };
}

const call = (overrides: Partial<GitCall> = {}): GitCall => ({ project: '/p', cwd: '/p', args: ['status'], kind: 'read', ...overrides });

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('git runner', () => {
  it('spawns the absolute git path as argv, never a shell', async () => {
    const { spawned, instance } = runner();
    const done = instance.run(call({ args: ['status', '-z'] }));
    await settle();
    expect(spawned[0]!.spec.file).toBe(GIT.path);
    expect(spawned[0]!.spec.args).toEqual(['status', '-z']);
    expect(spawned[0]!.spec.shell).toBe(false);
    spawned[0]!.finish(0);
    await done;
  });

  it('runs every call with no prompt and no editor; parsed output gets LC_ALL=C and status no optional locks', async () => {
    const { spawned, instance } = runner();
    void instance.run(call({ kind: 'mutation' }));
    void instance.run(call({ kind: 'status', parsed: true }));
    await settle();
    const [mutation, status] = spawned.map((entry) => entry.spec.env!);
    for (const env of [mutation!, status!]) {
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
      expect(env['GIT_EDITOR']).toBe('true');
      expect(env['GIT_MERGE_AUTOEDIT']).toBe('no');
    }
    expect(mutation!['LC_ALL']).toBeUndefined();
    expect(mutation!['GIT_OPTIONAL_LOCKS']).toBeUndefined();
    expect(status!['LC_ALL']).toBe('C');
    expect(status!['GIT_OPTIONAL_LOCKS']).toBe('0');
  });

  it('sets literal pathspecs only on calls that name paths, so a hook keeps its own globs', async () => {
    const { spawned, instance } = runner();
    void instance.run(call({ kind: 'mutation', args: ['add', '-A', '--', 'a*'], literalPathspecs: true }));
    void instance.run(call({ kind: 'mutation', args: ['commit', '--file', '-'] }));
    await settle();
    expect(spawned[0]!.spec.env!['GIT_LITERAL_PATHSPECS']).toBe('1');
    expect(spawned[1]!.spec.env!['GIT_LITERAL_PATHSPECS']).toBeUndefined();
  });

  it('drops an inherited pathspec mode, which would switch off pathspec magic, and sets only its own', () => {
    const modes = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];
    for (const key of modes) process.env[key] = '1';
    try {
      const plain = gitEnv({ kind: 'read' });
      expect(modes.filter((key) => Object.keys(plain).some((name) => name.toUpperCase() === key))).toEqual([]);
      const literal = gitEnv({ kind: 'mutation', literalPathspecs: true });
      expect(Object.keys(literal).filter((name) => modes.includes(name.toUpperCase()))).toEqual(['GIT_LITERAL_PATHSPECS']);
    } finally {
      for (const key of modes) delete process.env[key];
    }
  });

  it('drops inherited repository-local git variables', async () => {
    process.env['GIT_DIR'] = '/elsewhere/.git';
    try {
      const { spawned, instance } = runner();
      void instance.run(call());
      await settle();
      expect(spawned[0]!.spec.env!['GIT_DIR']).toBeUndefined();
    } finally {
      delete process.env['GIT_DIR'];
    }
  });

  it('starts no process for an untrusted project', async () => {
    const { spawned, lines, instance } = runner(false);
    await expect(instance.run(call())).rejects.toBeInstanceOf(GitUntrustedError);
    expect(spawned).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('logs argv, duration and exit code with URL userinfo redacted, and never the stdin', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ args: ['remote', 'add', 'origin', 'https://user:s3cret@example.com/r.git'], input: 'commit message secret', allowFailure: true }));
    await settle();
    expect(spawned[0]!.stdin.join('')).toBe('commit message secret');
    spawned[0]!.finish(128, '', 'fatal: unable to access https://token@example.com/r.git\n');
    await done;
    const log = lines.join('\n');
    expect(log).toContain('> git remote add origin https://example.com/r.git [0ms] exit 128');
    expect(log).toContain('https://example.com/r.git');
    expect(log).not.toContain('s3cret');
    expect(log).not.toContain('token@');
    expect(log).not.toContain('commit message secret');
  });

  it('quotes arguments holding line breaks, so a file name cannot forge a log line', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ args: ['add', '--', 'a\n> git push --force'] }));
    await settle();
    spawned[0]!.finish(0);
    await done;
    expect(lines).toEqual(['> git add -- "a\\n> git push --force" [0ms]']);
  });

  it('escapes bidi controls and line separators inside a quoted argument', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ args: ['add', '--', 'a\u202eb\u2028c\u2029d\u0085e\u2066f'] }));
    await settle();
    spawned[0]!.finish(0);
    await done;
    expect(lines).toEqual(['> git add -- "a\\u202eb\\u2028c\\u2029d\\u0085e\\u2066f" [0ms]']);
  });

  it('names the subcommand, not a leading -c, in an error', async () => {
    const { spawned, instance } = runner();
    const done = instance.run(call({ kind: 'mutation', args: ['-c', 'user.useConfigOnly=true', 'commit', '--quiet'] }));
    await settle();
    spawned[0]!.finish(1, 'nothing to commit, working tree clean\n');
    const error = await done.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toBe('git commit exited with 1');
  });

  it('starts a cancellable call in the session job, and never an index write', async () => {
    const { spawned, instance } = runner();
    const session = { id: 7, dispose: () => undefined };
    void instance.run(call({ kind: 'status', signal: new AbortController().signal, session }));
    void instance.run(call({ kind: 'mutation', args: ['add', '--', 'a'], session }));
    await settle();
    expect(spawned.map((entry) => entry.spec.job)).toEqual([7, undefined]);
    expect(spawned.map((entry) => entry.spec.detached)).toEqual([process.platform !== 'win32', false]);
  });

  it("kills a cancelled call's whole tree, and never an uncancellable call past its bound", async () => {
    const { spawned, instance } = runner();
    const controller = new AbortController();
    const cancelled = instance.run(call({ signal: controller.signal })).catch(() => undefined);
    const bounded = instance.run(call({ args: ['diff'], maxOutputBytes: 1 })).catch(() => undefined);
    await settle();
    controller.abort(new GitQueueDisposedError());
    spawned[1]!.finish(0, 'ab');
    await Promise.all([cancelled, bounded]);
    expect(spawned[0]!.kills).toEqual([{ tree: true }]);
    expect(spawned[1]!.kills).toEqual([]);
  });

  it('turns on core.longpaths for every call, ahead of the call\'s own config pairs', () => {
    expect(gitEnv({ kind: 'read' })).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' });
    expect(gitEnv({ kind: 'mutation', config: [['submodule.a=b.ignore', 'all']] })).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_KEY_1: 'submodule.a=b.ignore',
      GIT_CONFIG_VALUE_1: 'all',
    });
  });

  it('passes core.longpaths as a -c option to git before 2.31, which ignores GIT_CONFIG_COUNT', async () => {
    const fake = fakeLauncher();
    const instance = createGitRunner({ git: { ...GIT, version: { major: 2, minor: 30, patch: 2 } }, log: { appendLine: () => undefined }, isTrusted: () => true, launcher: fake.launcher, now: () => 0 });
    void instance.run(call({ args: ['worktree', 'add', '/wt'] }));
    void instance.clone({ cwd: '/p', args: ['clone', 'https://example.com/r.git', 'r'], signal: new AbortController().signal });
    await settle();
    expect(fake.launched.map((entry) => entry.spec.args)).toEqual([
      ['-c', 'core.longpaths=true', 'worktree', 'add', '/wt'],
      ['-c', 'core.longpaths=true', 'clone', 'https://example.com/r.git', 'r'],
    ]);
  });

  it('adds the ceiling to an inherited one', () => {
    process.env['GIT_CEILING_DIRECTORIES'] = '/inherited';
    try {
      expect(gitEnv({ kind: 'read', ceilingDirectories: ['/stop'] })['GIT_CEILING_DIRECTORIES']).toBe(['/stop', '/inherited'].join(path.delimiter));
    } finally {
      delete process.env['GIT_CEILING_DIRECTORIES'];
    }
  });

  it('lets an askpass registration set its own variables over inherited ones, never over the engine\'s safety variables', () => {
    const saved = { GIT_ASKPASS: process.env['GIT_ASKPASS'], SSH_ASKPASS: process.env['SSH_ASKPASS'] };
    process.env['GIT_ASKPASS'] = '/inherited/askpass';
    process.env['SSH_ASKPASS'] = '/inherited/ssh-askpass';
    try {
      const askpassEnv = { GIT_ASKPASS: '/app/askpass.sh', SSH_ASKPASS: '/app/ssh-askpass.sh', SSH_ASKPASS_REQUIRE: 'force', GIT_TERMINAL_PROMPT: '1', GIT_EDITOR: 'vim', GIT_MERGE_AUTOEDIT: 'yes', GIT_ALLOW_PROTOCOL: 'ext', LC_ALL: 'de_DE', GIT_OPTIONAL_LOCKS: '1', GIT_LITERAL_PATHSPECS: '0' };
      const env = gitEnv({ kind: 'status', parsed: true, localOnly: true, literalPathspecs: true, askpassEnv });
      expect(env).toMatchObject({ GIT_ASKPASS: '/app/askpass.sh', SSH_ASKPASS: '/app/ssh-askpass.sh', SSH_ASKPASS_REQUIRE: 'force' });
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_ALLOW_PROTOCOL: 'none', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a cancelled call with the signal\'s reason, even one whose failure is an answer, and spawns none once aborted', async () => {
    const { spawned, instance } = runner();
    const controller = new AbortController();
    const done = instance.run(call({ signal: controller.signal, allowFailure: true }));
    await settle();
    controller.abort(new GitQueueDisposedError());
    await expect(done).rejects.toBeInstanceOf(GitQueueDisposedError);
    expect(spawned[0]!.kills).toHaveLength(1);
    await expect(instance.run(call({ signal: controller.signal }))).rejects.toBeInstanceOf(GitQueueDisposedError);
    expect(spawned).toHaveLength(1);
  });

  it('logs a git that could not start apart from one whose launcher worker died, and a cancelled call as cancelled either way', async () => {
    const { spawned, lines, instance } = runner();
    const unstarted = instance.run(call());
    await settle();
    spawned[0]!.failStart(new Error('spawn EACCES'));
    await expect(unstarted).rejects.toThrow('spawn EACCES');
    const died = instance.run(call({ args: ['log'] }));
    await settle();
    spawned[1]!.die(new Error('the launcher worker died'));
    await expect(died).rejects.toThrow('the launcher worker died');
    const controller = new AbortController();
    const cancelled = instance.run(call({ args: ['fetch'], signal: controller.signal }));
    await settle();
    controller.abort(new GitQueueDisposedError());
    spawned[2]!.die(new Error('the launcher worker died'));
    await expect(cancelled).rejects.toBeInstanceOf(GitQueueDisposedError);
    expect(lines).toEqual(['> git status [failed to start: spawn EACCES]', '> git log [failed: the launcher worker died]', '> git fetch [0ms] cancelled']);
  });

  it('keeps a UTF-8 sequence that ends the output cut, as the decoder ends it', async () => {
    const { spawned, instance } = runner();
    const failed = instance.run(call());
    await settle();
    spawned[0]!.finish(1, '', Buffer.from([0x66, 0xe2, 0x82]));
    const error = await failed.catch((err: unknown) => err);
    expect((error as GitError).stderr).toBe('f\uFFFD');
    const chunks: string[] = [];
    const streamed = instance.run(call({ onData: (chunk) => void chunks.push(chunk) }));
    await settle();
    spawned[1]!.finish(0, Buffer.from([0x61, 0xc3]));
    await streamed;
    expect(chunks.join('')).toBe('a\uFFFD');
  });

  it('never kills an index write whose output passes the bound, and rejects it as too large once it ends', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ kind: 'mutation', args: ['commit'], maxOutputBytes: 3 }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    await expect(done).rejects.toBeInstanceOf(GitOutputTooLargeError);
    expect(spawned[0]!.kills).toEqual([]);
    expect(lines[0]).toBe('> git commit [0ms], output over 3 bytes');
  });

  it('never resolves part of a read past the bound as its whole output', async () => {
    const { spawned, instance } = runner();
    const done = instance.run(call({ args: ['diff', '--binary'], maxOutputBytes: 3 }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    const error = await done.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitOutputTooLargeError);
    expect((error as GitOutputTooLargeError).maxBytes).toBe(3);
  });

  it('bounds a call that names no bound by the runner\'s own', async () => {
    const fake = fakeLauncher();
    const instance = createGitRunner({ git: GIT, log: { appendLine: () => undefined }, isTrusted: () => true, launcher: fake.launcher, now: () => 0, maxOutputBytes: 4 });
    const done = instance.run(call());
    await settle();
    fake.launched[0]!.finish(0, 'abcdef');
    await expect(done).rejects.toBeInstanceOf(GitOutputTooLargeError);
  });

  it('keeps a preview call\'s output up to the bound and marks it truncated', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ args: ['cat-file', '--batch'], maxOutputBytes: 3, preview: true }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    const result = await done;
    expect(result.stdout.toString('utf8')).toBe('abc');
    expect(result.truncated).toBe(true);
    expect(spawned[0]!.kills).toEqual([]);
    expect(lines[0]).toBe('> git cat-file --batch [0ms], output past 3 bytes not kept');
  });

  it('marks no preview truncated when its output fits the bound', async () => {
    const { spawned, instance } = runner();
    const done = instance.run(call({ maxOutputBytes: 6, preview: true }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    const result = await done;
    expect(result.stdout.toString('utf8')).toBe('abcdef');
    expect(result.truncated).toBeUndefined();
  });

  it('stops a streamed read when onData asks and resolves with what was read', async () => {
    const { spawned, instance } = runner();
    const chunks: string[] = [];
    const done = instance.run(call({ onData: (chunk) => (chunks.push(chunk), 'stop') }));
    await settle();
    spawned[0]!.finish(1, 'first');
    const result = await done;
    expect(chunks).toEqual(['first']);
    expect(result.exitCode).toBe(0);
  });

  it('keeps none of a streamed call\'s output itself, and its bound does not cut what onData reads', async () => {
    const { spawned, lines, instance } = runner();
    let read = '';
    const done = instance.run(call({ maxOutputBytes: 3, onData: (chunk) => {
      read += chunk;
      return undefined;
    } }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    const result = await done;
    expect(read).toBe('abcdef');
    expect(result.stdout.length).toBe(0);
    expect(lines[0]).toBe('> git status [0ms]');
  });
});

describe('argument hygiene', () => {
  it('refuses a ref that git would read as an option', () => {
    expect(isSafeRevision('--upload-pack=x')).toBe(false);
    expect(() => revision('--upload-pack=x')).toThrow();
    expect(() => revision('-x')).toThrow();
  });

  it('refuses malformed refs and accepts plain ones', () => {
    for (const bad of ['a..b', 'a b', 'HEAD@{1}', 'a:b', 'a~1', 'feature/', 'x.lock', '.hidden', 'a\nb', '']) expect(isSafeRevision(bad)).toBe(false);
    for (const good of ['HEAD', 'main', 'feature/login', 'v1.2.3']) expect(isSafeRevision(good)).toBe(true);
  });

  it('reads git versions', () => {
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toEqual({ major: 2, minor: 45, patch: 1 });
    expect(parseGitVersion('git version 2.39')).toEqual({ major: 2, minor: 39, patch: 0 });
    expect(parseGitVersion('nope')).toBeUndefined();
    expect(gitAtLeast({ major: 2, minor: 24, patch: 0 }, 2, 24)).toBe(true);
    expect(gitAtLeast({ major: 2, minor: 23, patch: 9 }, 2, 24)).toBe(false);
  });

  it('redacts userinfo of any scheme', () => {
    expect(redactUrls('ssh://git:pw@host/x and https://tok@h.com/y')).toBe('ssh://host/x and https://h.com/y');
  });
});

describe('repository queue', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('runs at most four reads at once', async () => {
    const queue = new RepoQueue();
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred());
    const all = gates.map((gate) =>
      queue.read(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );
    await settle();
    expect(running).toBe(4);
    for (const gate of gates) gate.resolve();
    await Promise.all(all);
    expect(peak).toBe(4);
  });

  it('runs a mutation exclusive of status and other mutations, in arrival order', async () => {
    const queue = new RepoQueue();
    const order: string[] = [];
    const first = deferred();
    const mutation = queue.mutation(async () => {
      order.push('mutation start');
      await first.promise;
      order.push('mutation end');
    });
    const status = queue.status(async () => {
      order.push('status');
    });
    const second = queue.mutation(async () => {
      order.push('second mutation');
    });
    await settle();
    expect(order).toEqual(['mutation start']);
    expect(queue.busy).toBe(true);
    first.resolve();
    await Promise.all([mutation, status, second]);
    expect(order).toEqual(['mutation start', 'mutation end', 'status', 'second mutation']);
    expect(queue.busy).toBe(false);
  });

  it('runs one status at a time plus one trailing run that every later request joins', async () => {
    const queue = new RepoQueue();
    let runs = 0;
    const gate = deferred();
    const firstRun = queue.status(async () => {
      runs++;
      await gate.promise;
      return runs;
    });
    await settle();
    const trailing = [queue.status(async () => ++runs), queue.status(async () => ++runs), queue.status(async () => ++runs)];
    expect(trailing[0]).toBe(trailing[1]);
    expect(trailing[1]).toBe(trailing[2]);
    gate.resolve();
    expect(await firstRun).toBe(1);
    expect(await Promise.all(trailing)).toEqual([2, 2, 2]);
    expect(runs).toBe(2);
  });

  it('says it is busy while a mutation runs or waits, and tells its listeners when that changes', async () => {
    const queue = new RepoQueue();
    let changes = 0;
    queue.onIdleChange(() => changes++);
    const gate = deferred();
    const status = queue.status(async () => gate.promise);
    await settle();
    expect(queue.busy).toBe(false);
    const mutation = queue.mutation(async () => undefined);
    expect(queue.busy).toBe(true);
    expect(changes).toBe(1);
    gate.resolve();
    await Promise.all([status, mutation]);
    await settle();
    expect(queue.busy).toBe(false);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('keeps running after a task that throws before it returns a promise', async () => {
    const queue = new RepoQueue();
    const thrown = queue.mutation((() => {
      throw new Error('synchronous');
    }) as () => Promise<void>);
    await expect(thrown).rejects.toThrow('synchronous');
    expect(queue.busy).toBe(false);
    expect(await queue.status(async () => 'next')).toBe('next');
    await expect(queue.read((() => {
      throw new Error('read');
    }) as () => Promise<void>)).rejects.toThrow('read');
  });

  it('aborts its signal when disposed, with the queue\'s own error', () => {
    const queue = new RepoQueue();
    expect(queue.signal.aborted).toBe(false);
    queue.dispose();
    expect(queue.signal.aborted).toBe(true);
    expect(queue.signal.reason).toBeInstanceOf(GitQueueDisposedError);
  });

  it('rejects queued work when disposed, and lets the running index write finish', async () => {
    const queue = new RepoQueue();
    const gate = deferred();
    let finished = false;
    const running = queue.mutation(async () => {
      await gate.promise;
      finished = true;
    });
    const queued = queue.status(async () => 'never');
    await settle();
    queue.dispose();
    await expect(queued).rejects.toThrow('closed');
    await expect(queue.read(async () => 1)).rejects.toThrow('closed');
    gate.resolve();
    await running;
    expect(finished).toBe(true);
  });
});
