import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createShellJob, type ShellSessionJob } from '../../pi-session/tools/process-tree';
import { createGitRunner, gitAtLeast, gitEnv, GitError, GitQueueDisposedError, GitUntrustedError, isSafeRevision, parseGitVersion, redactUrls, RepoQueue, revision, type GitCall } from '../git-runner';

// Recorded rather than run: only a fake child with a pid reaches it, and the real one opens kernel handles.
vi.mock('../../pi-session/tools/process-tree', () => ({ createShellJob: vi.fn(() => undefined), killProcessTree: vi.fn() }));

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly stdin: string[];
  readonly kills: number[];
  finish(code: number, stdout?: string, stderr?: string): void;
}

function fakeSpawn(pid?: number): { spawned: Spawned[]; spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess } {
  const spawned: Spawned[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const written: string[] = [];
    const kills: number[] = [];
    stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    // a killed process closes with no exit code, as a signalled one does
    const kill = (): boolean => {
      kills.push(1);
      setImmediate(() => child.emit('close', null));
      return true;
    };
    Object.assign(child, { stdout, stderr, stdin, kill, pid });
    spawned.push({
      command,
      args,
      options,
      stdin: written,
      kills,
      finish: (code, out = '', err = '') => {
        stdout.end(out);
        stderr.end(err);
        setImmediate(() => child.emit('close', code));
      },
    });
    return child;
  };
  return { spawned, spawn };
}

const GIT = { path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: { major: 2, minor: 45, patch: 1 } };

function runner(trusted = true, pid?: number) {
  const fake = fakeSpawn(pid);
  const lines: string[] = [];
  const instance = createGitRunner({ git: GIT, log: { appendLine: (line) => lines.push(line) }, isTrusted: () => trusted, spawn: fake.spawn, now: () => 0 });
  return { ...fake, lines, instance };
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
    expect(spawned[0]!.command).toBe(GIT.path);
    expect(spawned[0]!.args).toEqual(['status', '-z']);
    expect(spawned[0]!.options.shell).toBe(false);
    spawned[0]!.finish(0);
    await done;
  });

  it('runs every call with no prompt and no editor; parsed output gets LC_ALL=C and status no optional locks', async () => {
    const { spawned, instance } = runner();
    void instance.run(call({ kind: 'mutation' }));
    void instance.run(call({ kind: 'status', parsed: true }));
    await settle();
    const [mutation, status] = spawned.map((entry) => entry.options.env!);
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
    expect(spawned[0]!.options.env!['GIT_LITERAL_PATHSPECS']).toBe('1');
    expect(spawned[1]!.options.env!['GIT_LITERAL_PATHSPECS']).toBeUndefined();
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
      expect(spawned[0]!.options.env!['GIT_DIR']).toBeUndefined();
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

  it('puts a cancellable call in its own job inside the session job, and never an index write', async () => {
    const { spawned, instance } = runner(true, 4242);
    const session: ShellSessionJob = { dispose: () => undefined };
    vi.mocked(createShellJob).mockClear();
    void instance.run(call({ kind: 'status', signal: new AbortController().signal, session }));
    void instance.run(call({ kind: 'mutation', args: ['add', '--', 'a'], session }));
    await settle();
    expect(vi.mocked(createShellJob).mock.calls).toEqual([[4242, session]]);
    expect(spawned.map((entry) => entry.options.detached)).toEqual([process.platform !== 'win32', false]);
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

  it('never kills an index write whose output passes the bound, and drops the rest of the output', async () => {
    const { spawned, lines, instance } = runner();
    const done = instance.run(call({ kind: 'mutation', args: ['commit'], maxOutputBytes: 3 }));
    await settle();
    spawned[0]!.finish(0, 'abcdef');
    const result = await done;
    expect(result.exitCode).toBe(0);
    expect(spawned[0]!.kills).toEqual([]);
    expect(lines[0]).toBe('> git commit [0ms], output over 3 bytes dropped');
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
