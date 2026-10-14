import { describe, expect, it, vi } from 'vitest';
import { INPUT_VALIDATIONS, inputProblem } from '../../../shared/input-validation';
import { autofetchPeriodSeconds, Autofetcher, type AutofetchTarget } from '../autofetch';
import { cloneArgs, cloneFolderName, isCloneFolderName } from '../clone';
import { GitError } from '../git-runner';
import { isRemoteName, isRemoteUrl, parseRemoteBranches, parseRemoteNames, parseRemotes, parseUpstream } from '../remotes';
import { gitErrorText, keptStashOutcome } from '../scm-service';
import { fetchArgs, needsStashAroundPull, pullArgs, pullTarget, pushArgs } from '../sync';

const V2_23 = { major: 2, minor: 23, patch: 0 };
const V2_26 = { major: 2, minor: 26, patch: 0 };
const V2_29 = { major: 2, minor: 29, patch: 0 };
const V2_43 = { major: 2, minor: 43, patch: 0 };

describe('remote names and URLs', () => {
  it('accepts plain names only, never one git could read as an option or a refspec', () => {
    for (const name of ['origin', 'up-stream', 'fork_2', 'a.b']) expect(isRemoteName(name), name).toBe(true);
    for (const name of ['', '-x', '--upload-pack=x', '+main', '.hidden', 'a..b', 'a.', 'x.lock', 'a b', 'a/b', 'a:b', 'ä', 'x'.repeat(101)]) expect(isRemoteName(name), name).toBe(false);
  });

  it('accepts exactly the remote names the overlay\'s remoteName validation accepts', () => {
    expect(INPUT_VALIDATIONS).toContain('remoteName');
    const names = ['origin', 'up-stream', 'fork_2', 'a.b', '9lives', 'x'.repeat(100), 'x'.repeat(101), '', '-x', '--upload-pack=x', '+main', '.hidden', '_a', 'a..b', 'a.', 'x.lock', 'a b', 'a/b', 'a:b', 'ä', 'a\tb', 'a\u0007', 'A.lock.b'];
    for (const name of names) expect(isRemoteName(name), name).toBe(inputProblem('remoteName', name, { windows: false }) === undefined);
  });

  it('accepts a URL or path, a local path with spaces included, never a leading dash, a control character, a remote helper or whitespace in a URL', () => {
    const accepted = ['https://example.com/a.git', 'git@example.com:a/b.git', 'ssh://example.com/a', '../local.git', 'C:/repos/a.git', 'C:\\Users\\John Doe\\repo', '/home/john doe/r', '\\\\srv\\share\\a b', '../my repo.git'];
    for (const url of accepted) expect(isRemoteUrl(url), url).toBe(true);
    const refused = ['', '-uhttps://x', '--upload-pack=touch', '-x', ' -oProxyCommand=x:p', ' /home/x', '\u00a0../x', 'ext::sh -c x', 'EXT::a b', 'ext::x', 'fd::17', 'fd::0', 'a+b.c::x', 'https://a b', 'https://h/a b', 'host:a b', 'https://a\tb', 'https://a\u0007b', 'a\nb', 'a\rb', 'a\tb', 'a\u0085b', '/a\u2028b', 'x'.repeat(2049)];
    for (const url of refused) expect(isRemoteUrl(url), JSON.stringify(url)).toBe(false);
  });

  it('reads remote names and URLs, a partial clone\'s filtered fetch line included, leaving out a name the engine refuses', () => {
    expect(parseRemoteNames('origin\n--upload-pack=x\nbackup\n')).toEqual(['backup', 'origin']);
    expect(parseRemotes('origin\thttps://example.com/a.git (fetch)\norigin\thttps://example.com/push.git (push)\n-x\t../x (fetch)\n')).toEqual([{ name: 'origin', fetchUrl: 'https://example.com/a.git', pushUrl: 'https://example.com/push.git' }]);
    expect(parseRemotes('origin\thttps://example.com/a b.git (fetch) [blob:none]\norigin\thttps://example.com/a b.git (push)\n')).toEqual([{ name: 'origin', fetchUrl: 'https://example.com/a b.git', pushUrl: 'https://example.com/a b.git' }]);
  });

  it('reads the upstream of exactly HEAD\'s branch with its counts, and none for a branch without one or whose upstream is gone', () => {
    const ref = 'refs/heads/main';
    expect(parseUpstream(`refs/heads/main/x\0origin\0refs/heads/x\0ahead 9\n${ref}\0origin\0refs/heads/main\0ahead 1, behind 2\n`, ref)).toEqual({ remote: 'origin', branch: 'main', ahead: 1, behind: 2 });
    expect(parseUpstream(`${ref}\0origin\0refs/heads/trunk\0gone\n`, ref)).toBeNull();
    expect(parseUpstream(`${ref}\0origin\0refs/heads/main\0\n`, ref)).toEqual({ remote: 'origin', branch: 'main', ahead: 0, behind: 0 });
    expect(parseUpstream(`${ref}\0\0\0\n`, ref)).toBeNull();
  });

  it('lists a remote\'s fetched branches without HEAD', () => {
    expect(parseRemoteBranches('refs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/remotes/origin/feat/x\nrefs/remotes/originx/y\n', 'origin')).toEqual(['main', 'feat/x']);
  });
});

describe('fetch, pull and push argv', () => {
  it('fetches the default remote, one remote after --end-of-options, or all, with --prune when asked', () => {
    expect(fetchArgs({ prune: false }, V2_43)).toEqual(['fetch']);
    expect(fetchArgs({ prune: true }, V2_43)).toEqual(['fetch', '--prune']);
    expect(fetchArgs({ remote: 'origin', prune: false }, V2_43)).toEqual(['fetch', '--end-of-options', 'origin']);
    expect(fetchArgs({ remote: 'origin', prune: false }, V2_23)).toEqual(['fetch', 'origin']);
    expect(fetchArgs({ all: true, prune: true }, V2_43)).toEqual(['fetch', '--prune', '--all']);
    expect(() => fetchArgs({ remote: '--upload-pack=touch x', prune: false }, V2_43)).toThrow();
  });

  it('pulls the named upstream branch as a full ref, with --autostash from git 2.27 and -r for a rebase', () => {
    expect(pullArgs({ rebase: false, autoStash: false }, V2_43)).toEqual(['pull']);
    expect(pullArgs({ rebase: true, autoStash: true, remote: 'origin', branch: 'main' }, V2_43)).toEqual(['pull', '--autostash', '-r', '--end-of-options', 'origin', 'refs/heads/main']);
    expect(pullArgs({ rebase: false, autoStash: true }, V2_26)).toEqual(['pull']);
    expect(() => pullArgs({ rebase: false, autoStash: false, remote: '-x', branch: 'main' }, V2_43)).toThrow();
    expect(() => pullArgs({ rebase: false, autoStash: false, remote: 'origin', branch: 'a..b' }, V2_43)).toThrow();
  });

  it('names an upstream only as a remote and a branch under refs/heads, else leaves the pull to git', () => {
    expect(pullTarget({ remote: 'origin', branch: 'feat/x', ahead: 0, behind: 0 })).toEqual({ remote: 'origin', branch: 'feat/x' });
    expect(pullTarget({ remote: '.', branch: 'main', ahead: 0, behind: 0 })).toEqual({ remote: '.', branch: 'main' });
    expect(pullTarget({ remote: 'origin', branch: 'refs/pull/1/head', ahead: 0, behind: 0 })).toBeUndefined();
    expect(pullTarget({ remote: 'a/b', branch: 'main', ahead: 0, behind: 0 })).toBeUndefined();
    expect(pullTarget({ remote: 'origin', branch: 'a..b', ahead: 0, behind: 0 })).toBeUndefined();
  });

  it('pushes full refs, so a branch named like a forced refspec stays a branch, and forces only with a lease', () => {
    expect(pushArgs({ remote: 'origin', branch: 'main', toBranch: 'trunk', setUpstream: false, followTags: false, force: false }, V2_43)).toEqual(['push', '--end-of-options', 'origin', 'refs/heads/main:refs/heads/trunk']);
    expect(pushArgs({ remote: 'origin', branch: '+main', setUpstream: true, followTags: false, force: false }, V2_43)).toEqual(['push', '-u', '--end-of-options', 'origin', 'refs/heads/+main:refs/heads/+main']);
    expect(pushArgs({ setUpstream: false, followTags: true, force: true }, V2_43)).toEqual(['push', '--force-with-lease', '--force-if-includes', '--follow-tags']);
    expect(pushArgs({ setUpstream: false, followTags: false, force: true }, V2_29)).toEqual(['push', '--force-with-lease']);
    expect(pushArgs({ setUpstream: false, followTags: false, force: true }, V2_43)).not.toContain('--force');
  });

  it('stashes around a pull itself only with a git before 2.27 and autoStash on', () => {
    expect(needsStashAroundPull(V2_26, true)).toBe(true);
    expect(needsStashAroundPull(V2_26, false)).toBe(false);
    expect(needsStashAroundPull(V2_43, true)).toBe(false);
  });
});

describe('clone', () => {
  it('names the folder after the URL\'s last segment as VS Code does, refusing a name that is no plain folder', () => {
    expect(cloneFolderName('https://example.com/org/acme-api.git')).toBe('acme-api');
    expect(cloneFolderName('git@example.com:org/acme.git/')).toBe('acme');
    expect(cloneFolderName('https://example.com/org/caf%C3%A9.git')).toBe('café');
    expect(cloneFolderName('https://example.com/org/%E0%A4%A.git')).toBe('%E0%A4%A');
    expect(cloneFolderName('https://example.com/-x.git')).toBeUndefined();
    expect(cloneFolderName('https://example.com/..')).toBeUndefined();
    expect(isCloneFolderName('con', 'win32')).toBe(false);
    expect(isCloneFolderName('con', 'linux')).toBe(true);
  });

  it('puts the URL and the target after --, recursive through --recurse-submodules, never protocol.file.allow', () => {
    expect(cloneArgs('https://example.com/a.git', '/x/a', false)).toEqual(['clone', '--', 'https://example.com/a.git', '/x/a']);
    const recursive = cloneArgs('https://example.com/a.git', '/x/a', true);
    expect(recursive).toEqual(['clone', '--recurse-submodules', '--', 'https://example.com/a.git', '/x/a']);
    expect(recursive.join(' ')).not.toContain('protocol');
    expect(() => cloneArgs('--upload-pack=touch x', '/x/a', false)).toThrow();
    expect(() => cloneArgs('ext::sh', '/x/a', false)).toThrow();
  });
});

describe('a remote operation whose pull kept the stash', () => {
  it('finished when it was a pull that went through, stopped when a sync still had its push to run, and cancelled when cancelled', () => {
    expect(keptStashOutcome('pull', 'ok')).toBe('ok');
    expect(keptStashOutcome('pull', 'failed')).toBe('failed');
    expect(keptStashOutcome('pull', 'cancelled')).toBe('cancelled');
    expect(keptStashOutcome('sync', 'ok')).toBe('failed');
    expect(keptStashOutcome('sync', 'cancelled')).toBe('cancelled');
  });
});

describe('autofetch', () => {
  function fetcher(targets: () => AutofetchTarget[], enabled = true) {
    const log: string[] = [];
    const autofetch = new Autofetcher({ enabled: () => enabled, periodMs: () => 180_000, targets, log: (line) => log.push(line), describe: gitErrorText });
    return { autofetch, log };
  }

  it('clamps the period to a second and a day, so a hand-edited value never overflows the timer', () => {
    expect(autofetchPeriodSeconds(180)).toBe(180);
    expect(autofetchPeriodSeconds(0)).toBe(1);
    expect(autofetchPeriodSeconds(-5)).toBe(1);
    expect(autofetchPeriodSeconds(86_401)).toBe(86_400);
    expect(autofetchPeriodSeconds(3_000_000)).toBe(86_400);
    expect(autofetchPeriodSeconds(1.5)).toBe(180);
    expect(autofetchPeriodSeconds('60')).toBe(180);
  });

  it('fetches each target at once and every period after, skipping a busy one', async () => {
    vi.useFakeTimers();
    try {
      const fetched: string[] = [];
      const targets = (): AutofetchTarget[] => [
        { key: 'a', idle: () => true, fetch: async () => void fetched.push('a') },
        { key: 'b', idle: () => false, fetch: async () => void fetched.push('b') },
      ];
      const { autofetch } = fetcher(targets);
      autofetch.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetched).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(179_000);
      expect(fetched).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetched).toEqual(['a', 'a']);
      autofetch.stop();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(fetched).toEqual(['a', 'a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks whether a target is idle right before its fetch, so an operation started during an earlier fetch of the round is skipped', async () => {
    let busy = false;
    const fetched: string[] = [];
    let releaseA!: () => void;
    const targets: AutofetchTarget[] = [
      { key: 'a', idle: () => true, fetch: () => new Promise<void>((resolve) => { fetched.push('a'); releaseA = resolve; }) },
      { key: 'b', idle: () => !busy, fetch: async () => void fetched.push('b') },
    ];
    const { autofetch } = fetcher(() => targets);
    autofetch.start();
    await vi.waitFor(() => expect(fetched).toEqual(['a']));
    busy = true;
    releaseA();
    await autofetch.yieldTo('b');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetched).toEqual(['a']);
    autofetch.stop();
  });

  // curl words a refused connection with the time it took, which differs on every attempt
  it('logs a refused connection once however long each attempt took', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const target: AutofetchTarget = {
        key: 'a',
        idle: () => true,
        fetch: async () => {
          const ms = [0, 18, 2034][attempt++ % 3];
          throw new GitError('git fetch exited with 128', 128, '', `fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after ${ms} ms: Couldn't connect to server\n`);
        },
      };
      const { autofetch, log } = fetcher(() => [target]);
      autofetch.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(attempt).toBe(3);
      expect(log).toEqual(["[scm] autofetch failed: fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server"]);
      autofetch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failure once until a fetch succeeds, and stops a common dir whose credentials git or ssh refused until the next start', async () => {
    vi.useFakeTimers();
    try {
      let outcome: 'network' | 'auth' | 'ssh' | 'ok' = 'network';
      let calls = 0;
      const target: AutofetchTarget = {
        key: 'a',
        idle: () => true,
        fetch: async () => {
          calls++;
          if (outcome === 'network') throw new GitError('git fetch exited with 128', 128, '', 'fatal: unable to access \'https://example.com/\': Could not resolve host\n');
          if (outcome === 'auth') throw new GitError('git fetch exited with 128', 128, '', "fatal: could not read Username for 'https://example.com': terminal prompts disabled\n");
          // ssh's refusal is neither an error: nor a fatal: line, so the logged text never holds it
          if (outcome === 'ssh') throw new GitError('git fetch exited with 128', 128, '', 'git@example.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\n');
        },
      };
      const { autofetch, log } = fetcher(() => [target]);
      autofetch.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls).toBe(2);
      expect(log).toHaveLength(1);
      outcome = 'auth';
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.advanceTimersByTimeAsync(360_000);
      expect(calls).toBe(3);
      expect(log).toHaveLength(2);
      outcome = 'ssh';
      autofetch.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(360_000);
      expect(calls).toBe(4);
      expect(log.at(-1)).toBe('[scm] autofetch failed: fatal: Could not read from remote repository.');
      outcome = 'ok';
      autofetch.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills its fetch of a common dir an interactive operation takes over, and resolves once it ended', async () => {
    let aborted = false;
    let started = false;
    const target: AutofetchTarget = {
      key: 'a',
      idle: () => true,
      fetch: (signal) => new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
    };
    const { autofetch, log } = fetcher(() => [target]);
    autofetch.start();
    await vi.waitFor(() => expect(started).toBe(true));
    await autofetch.yieldTo('a');
    expect(aborted).toBe(true);
    expect(log).toEqual([]);
    autofetch.stop();
  });

  it('forgets a stopped round\'s fetch, so an operation never waits on one that ignores its kill', async () => {
    let started = false;
    const target: AutofetchTarget = { key: 'a', idle: () => true, fetch: () => new Promise(() => void (started = true)) };
    const { autofetch } = fetcher(() => [target]);
    autofetch.start();
    await vi.waitFor(() => expect(started).toBe(true));
    autofetch.stop();
    await autofetch.yieldTo('a');
  });

  it('does nothing while disabled', async () => {
    const fetch = vi.fn(async () => undefined);
    const { autofetch } = fetcher(() => [{ key: 'a', idle: () => true, fetch }], false);
    autofetch.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).not.toHaveBeenCalled();
  });
});
