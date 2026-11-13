import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSpec } from '../../process-launcher/protocol';
import { gitSshOf, parseSshConfigDump, readRemoteEndpoints, type GitSshSources } from '../remote-endpoints';
import { parseRemotes } from '../remotes';
import { git, harness, HAS_GIT, makeRepo, ready, sandbox, useGitSandbox } from './git-harness';

/**
 * Remote endpoints against real git and a fake ssh: `git remote -v`, git's credential.username, and `ssh -G` for an alias in a
 * trusted project only. The fake ssh is a Node script that answers as `ssh -G` does from an ssh config of its own, started
 * through the real launcher in place of the absolute path resolveSsh gives.
 */
useGitSandbox();

// git's ssh comes from the environment first, so a developer's own GIT_SSH_COMMAND or GIT_SSH stays out of these tests
beforeEach(() => {
  vi.stubEnv('GIT_SSH_COMMAND', undefined);
  vi.stubEnv('GIT_SSH', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const FAKE_SSH_NAME = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
const ssh = { calls: [] as { readonly file: string; readonly args: readonly string[] }[], script: '', path: '' };

vi.mock('../../process-launcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../process-launcher')>();
  return {
    ...actual,
    runProcess: (spec: SpawnSpec, options?: Parameters<typeof actual.runProcess>[1]) => {
      if (spec.file !== ssh.path) return actual.runProcess(spec, options);
      ssh.calls.push({ file: spec.file, args: spec.args });
      return actual.runProcess({ ...spec, file: process.execPath, args: [ssh.script, ...spec.args] }, options);
    },
  };
});

// gl-work is an alias of gitlab.com, as `Host gl-work\n  HostName gitlab.com` in ~/.ssh/config gives it
const FAKE_SSH = `
const [flag, dashes, alias] = process.argv.slice(2);
if (flag !== '-G' || dashes !== '--') { process.stderr.write('usage'); process.exit(255); }
const hosts = { 'gl-work': ['gitlab.com', '22'], 'gh-alt': ['ssh.github.com', '443'] };
const [hostname, port] = hosts[alias] ?? [alias.toLowerCase(), '22'];
process.stdout.write(['user git', 'hostname ' + hostname, 'port ' + port, 'identityfile ~/.ssh/id_ed25519', ''].join('\\n'));
`;

function fakeSsh(): string {
  ssh.calls.length = 0;
  ssh.script = path.join(sandbox, 'fake-ssh.cjs');
  fs.writeFileSync(ssh.script, FAKE_SSH, 'utf8');
  ssh.path = path.join(sandbox, 'bin', FAKE_SSH_NAME);
  fs.mkdirSync(path.dirname(ssh.path), { recursive: true });
  return ssh.path;
}

describe.skipIf(!HAS_GIT)('remote endpoints', { timeout: 60_000 }, () => {
  it('resolves git@gl-work:grp/sub/proj.git, gl-work an alias of gitlab.com, to grp/sub/proj on gitlab.com in a trusted project', async () => {
    const repoPath = makeRepo(path.join(sandbox, 'trusted'));
    git(['remote', 'add', 'origin', 'git@gl-work:grp/sub/proj.git'], repoPath);
    git(['remote', 'add', 'upstream', 'https://gitlab.com/grp/sub/proj.git'], repoPath);
    git(['remote', 'set-url', '--push', 'upstream', 'git@gh-alt:team/app.git'], repoPath);
    git(['config', 'credential.https://gitlab.com.username', 'alexios-s'], repoPath);
    const resolveSsh = fakeSsh();
    const h = harness({ trusted: [repoPath], resolveSsh: async () => resolveSsh });
    h.service.setProjects([{ key: 'p', path: repoPath }]);
    const repoId = (await ready(h)).repos[0]!.repoId;

    expect(await h.service.remoteEndpoints(repoId)).toEqual([
      { remote: 'origin', fetch: { protocol: 'ssh', host: 'gitlab.com', path: 'grp/sub/proj.git', aliasResolved: true } },
      {
        remote: 'upstream',
        fetch: { protocol: 'https', host: 'gitlab.com', path: 'grp/sub/proj.git', usernameHint: 'alexios-s', aliasResolved: false },
        push: { protocol: 'ssh', host: 'ssh.github.com', port: 443, path: 'team/app.git', aliasResolved: true },
      },
    ]);
    // ssh ran by the absolute path resolveSsh gave, with the alias after --, once per alias
    expect(ssh.calls).toEqual([{ file: resolveSsh, args: ['-G', '--', 'gl-work'] }, { file: resolveSsh, args: ['-G', '--', 'gh-alt'] }]);
    // the answers are kept for the core's run
    await h.service.remoteEndpoints(repoId);
    expect(ssh.calls).toHaveLength(2);
    h.service.dispose();
  });

  it('runs no ssh in an untrusted project, and keeps the alias as written', async () => {
    const repoPath = makeRepo(path.join(sandbox, 'untrusted'));
    git(['remote', 'add', 'origin', 'git@gl-work:grp/sub/proj.git'], repoPath);
    const resolveSsh = fakeSsh();
    // the trusted project opens the repository; trust then goes before the endpoints are read
    const h = harness({ trusted: [repoPath], resolveSsh: async () => resolveSsh });
    h.service.setProjects([{ key: 'p', path: repoPath }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    h.trust.revoke(repoPath);
    await expect(h.service.remoteEndpoints(repoId)).rejects.toThrow();
    // read with git as an older daemon's remotes are, then resolved outside a trusted project
    const remotes = parseRemotes(git(['remote', '-v'], repoPath));
    const endpoints = await readRemoteEndpoints({
      remotes: async () => remotes,
      credentialUsername: async () => undefined,
      trusted: () => false,
      gitSsh: async () => ({ label: 'ssh', file: resolveSsh, prefix: [] }),
      sshAnswers: new Map(),
      log: () => undefined,
    });
    expect(endpoints).toEqual([{ remote: 'origin', fetch: { protocol: 'ssh', host: 'gl-work', path: 'grp/sub/proj.git', aliasResolved: false } }]);
    expect(ssh.calls).toEqual([]);
    h.service.dispose();
  });

  it('keeps an alias as written when ssh cannot start, and asks again next time', async () => {
    const repoPath = makeRepo(path.join(sandbox, 'no-ssh'));
    git(['remote', 'add', 'origin', 'git@gl-work:grp/sub/proj.git'], repoPath);
    const missing = path.join(sandbox, 'absent', FAKE_SSH_NAME);
    const log: string[] = [];
    const answers = new Map();
    const read = () => readRemoteEndpoints({
      remotes: async () => parseRemotes(git(['remote', '-v'], repoPath)),
      credentialUsername: async () => undefined,
      trusted: () => true,
      gitSsh: async () => ({ label: 'ssh', file: missing, prefix: [] }),
      sshAnswers: answers,
      log: (line) => log.push(line),
    });
    expect((await read())[0]?.fetch).toMatchObject({ host: 'gl-work', aliasResolved: false });
    expect(log.join('\n')).toContain('ssh -G gl-work could not start');
    expect(answers.size).toBe(0);
  });

  it('reads credential.username per URL: a failed read is logged and read as unset, and the other remotes still resolve', async () => {
    const log: string[] = [];
    const endpoints = await readRemoteEndpoints({
      remotes: async () => [{ name: 'origin', fetchUrl: 'https://gitlab.com/grp/proj.git' }, { name: 'mirror', fetchUrl: 'https://github.com/team/app.git' }],
      credentialUsername: async (url) => {
        if (url.includes('gitlab.com')) throw new Error('git config --get-urlmatch exited 128');
        return 'octo';
      },
      trusted: () => true,
      gitSsh: async () => undefined,
      sshAnswers: new Map(),
      log: (line) => log.push(line),
    });
    expect(endpoints).toEqual([
      { remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.com', path: 'grp/proj.git', aliasResolved: false } },
      { remote: 'mirror', fetch: { protocol: 'https', host: 'github.com', path: 'team/app.git', usernameHint: 'octo', aliasResolved: false } },
    ]);
    expect(log.join('\n')).toContain('reading credential.username for a remote on gitlab.com failed');
  });
});

describe('git\'s ssh for an alias', () => {
  const sources = (env: Record<string, string | undefined>, configured?: string): GitSshSources & { readonly asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      env,
      configured: async () => {
        asked.push('core.sshCommand');
        return configured;
      },
      shell: async () => '/bin/sh',
      ssh: async () => '/usr/bin/ssh',
      program: async (name) => (name.startsWith('/') ? name : `/opt/bin/${name}`),
    };
  };

  it('is chosen as git chooses it: GIT_SSH_COMMAND, then core.sshCommand, then GIT_SSH, then ssh', async () => {
    const quiet = (): void => undefined;
    const fromEnv = sources({ GIT_SSH_COMMAND: 'ssh -F ~/.ssh/work', GIT_SSH: '/opt/plink' }, 'ssh -i ~/.ssh/repo');
    expect(await gitSshOf(fromEnv, quiet)).toEqual({ label: 'GIT_SSH_COMMAND', file: '/bin/sh', prefix: ['-c', 'ssh -F ~/.ssh/work "$@"', 'ssh -F ~/.ssh/work'] });
    // the environment wins without reading the repository's config, as git's getenv comes first
    expect(fromEnv.asked).toEqual([]);
    expect(await gitSshOf(sources({ GIT_SSH: '/opt/plink' }, 'ssh -i ~/.ssh/repo'), quiet)).toEqual({ label: 'core.sshCommand', file: '/bin/sh', prefix: ['-c', 'ssh -i ~/.ssh/repo "$@"', 'ssh -i ~/.ssh/repo'] });
    expect(await gitSshOf(sources({ GIT_SSH: '/opt/plink' }), quiet)).toEqual({ label: 'GIT_SSH', file: '/opt/plink', prefix: [] });
    expect(await gitSshOf(sources({ GIT_SSH: 'tortoiseplink' }), quiet)).toEqual({ label: 'GIT_SSH', file: '/opt/bin/tortoiseplink', prefix: [] });
    expect(await gitSshOf(sources({}), quiet)).toEqual({ label: 'ssh', file: '/usr/bin/ssh', prefix: [] });
  });

  it('runs none, logged, when git\'s shell, the GIT_SSH program or core.sshCommand cannot be had', async () => {
    const log: string[] = [];
    expect(await gitSshOf({ ...sources({ GIT_SSH_COMMAND: 'ssh' }), shell: async () => undefined }, (line) => log.push(line))).toBeUndefined();
    expect(await gitSshOf({ ...sources({ GIT_SSH: 'missing' }), program: async () => undefined }, (line) => log.push(line))).toBeUndefined();
    expect(await gitSshOf({ ...sources({}), configured: async () => Promise.reject(new Error('bad config')) }, (line) => log.push(line))).toBeUndefined();
    expect(log).toHaveLength(3);
  });

  describe.skipIf(!HAS_GIT)('through the shell git uses', { timeout: 60_000 }, () => {
    const opened = async (name: string, sshCommand?: string) => {
      const repoPath = makeRepo(path.join(sandbox, name));
      git(['remote', 'add', 'origin', 'git@gl-work:grp/sub/proj.git'], repoPath);
      if (sshCommand !== undefined) git(['config', 'core.sshCommand', sshCommand], repoPath);
      const h = harness({ trusted: [repoPath], resolveSsh: async () => path.join(sandbox, 'absent', FAKE_SSH_NAME) });
      h.service.setProjects([{ key: 'p', path: repoPath }]);
      const repoId = (await ready(h)).repos[0]!.repoId;
      return { h, repoId, log: h.serviceLog };
    };

    it('runs the repository\'s core.sshCommand with -G -- <alias>, and GIT_SSH_COMMAND before it', async () => {
      const { h, repoId } = await opened('core-ssh-command', "printf 'hostname gitlab.com\\nport 2222\\n'; :");
      expect(await h.service.remoteEndpoints(repoId)).toEqual([{ remote: 'origin', fetch: { protocol: 'ssh', host: 'gitlab.com', port: 2222, path: 'grp/sub/proj.git', aliasResolved: true } }]);
      // git's shell appends "$@", which the command reads as $1 to $3
      vi.stubEnv('GIT_SSH_COMMAND', "test \"$1 $2 $3\" = '-G -- gl-work' || exit 1; printf 'hostname ssh.github.com\\n'; :");
      expect((await h.service.remoteEndpoints(repoId))[0]?.fetch).toMatchObject({ host: 'ssh.github.com', aliasResolved: true });
      h.service.dispose();
    });

    it('maps the remote to no server when the command rejects -G or prints no hostname line, and logs why', async () => {
      const rejecting = await opened('rejecting-ssh-command', 'exit 255; :');
      expect(await rejecting.h.service.remoteEndpoints(rejecting.repoId)).toEqual([{ remote: 'origin' }]);
      expect(rejecting.log.join('\n')).toContain('core.sshCommand -G gl-work exited 255; the remote maps to no server');
      rejecting.h.service.dispose();
      const silent = await opened('silent-ssh-command', "printf 'user git\\n'; :");
      expect(await silent.h.service.remoteEndpoints(silent.repoId)).toEqual([{ remote: 'origin' }]);
      expect(silent.log.join('\n')).toContain('core.sshCommand -G gl-work printed no usable hostname line');
      silent.h.service.dispose();
    });
  });
});

describe('ssh -G\'s answer', () => {
  it('reads hostname and port, and brackets an IPv6 address as a URL holds it', () => {
    expect(parseSshConfigDump('user git\nhostname GitLab.com\nport 2222\n')).toEqual({ hostname: 'gitlab.com', port: 2222 });
    expect(parseSshConfigDump('hostname 2001:db8::1\nport 22\n')).toEqual({ hostname: '[2001:db8::1]' });
    expect(parseSshConfigDump('hostname bad_host!\n')).toBeUndefined();
    expect(parseSshConfigDump('user git\n')).toBeUndefined();
  });
});
