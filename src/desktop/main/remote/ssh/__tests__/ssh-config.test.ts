import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSshConfigSource, listSshConfigHosts, resolveSshHops, type SshConfigSource, type SshHopsInput } from '../ssh-config';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ssh-config-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const ACCOUNT = { username: 'ada', uid: 1000 };

// the host's flavour: the files are this computer's
function source(home: string, extra: Partial<SshConfigSource> = {}): SshConfigSource {
  return { userConfig: path.join(home, '.ssh', 'config'), account: { ...ACCOUNT, homedir: home }, platform: process.platform, env: {}, ...extra };
}

async function list(config: SshConfigSource): Promise<{ readonly hosts: string[]; readonly logs: string[] }> {
  const logs: string[] = [];
  const hosts = await listSshConfigHosts(config, (line) => logs.push(line));
  return { hosts, logs };
}

describe('listSshConfigHosts', () => {
  it('lists concrete aliases in order, skipping wildcard and negated patterns and special names', async () => {
    const root = tree({
      '.ssh/config': ['Host prod-1 prod-2', '  HostName 10.0.0.1', 'Host *.internal !secret staging?', 'Host=staging', 'host  .host', 'Host "quoted name"', 'Host prod-1'].join('\n'),
    });
    expect((await list(source(root))).hosts).toEqual(['prod-1', 'prod-2', 'staging']);
  });

  it('lists only names a connect accepts: no control, format or bidi character, at most 255 characters', async () => {
    const long = 'a'.repeat(256);
    const root = tree({ '.ssh/config': `Host ok ${long} ${'b'.repeat(255)} bell\u0007 rtl\u202eexe zero\u200bwidth\n` });
    expect((await list(source(root))).hosts).toEqual(['ok', 'b'.repeat(255)]);
  });

  it('splits arguments as argv_split does: quotes from anywhere in a word, escapes, tabs, and # only at a word start', async () => {
    const root = tree({
      '.ssh/config': [
        "Host 'single' \"double\" mid\"dle\"x esc\\\"q un\\qknown",
        'Host\ttabbed\tsecond',
        'Host = spaced # a comment',
        'Host a#b',
        "Host 'my host' foo\\ bar",
        '"Host" quoted-keyword',
        'Host "unterminated',
      ].join('\n'),
    });
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['single', 'double', 'middlex', 'esc"q', 'un\\qknown', 'tabbed', 'second', 'spaced', 'a#b', 'quoted-keyword']);
    expect(logs).toContain(`[ssh-config] ${path.join(root, '.ssh', 'config')} line 7: invalid quotes`);
  });

  it('separates arguments by space and tab only', async () => {
    const root = tree({ '.ssh/config': 'Include a\u00a0b\n', '.ssh/a\u00a0b': 'Host via-nbsp\n', '.ssh/a': 'Host wrong-a\n', '.ssh/b': 'Host wrong-b\n' });
    expect((await list(source(root))).hosts).toEqual(['via-nbsp']);
  });

  it('follows Include globs relative to ~/.ssh, ~ expansion, and an Include inside a Host block, in glob order', async () => {
    const root = tree({
      '.ssh/config': ['Host first', 'Include conf.d/*.conf', 'Host middle', '  Include ~/.ssh/inside', 'Host last'].join('\n'),
      '.ssh/conf.d/b.conf': 'Host from-b\n',
      '.ssh/conf.d/a.conf': 'Host from-a\nInclude nested\n',
      '.ssh/conf.d/ignored.txt': 'Host not-included\n',
      '.ssh/nested': 'Host from-nested\n',
      '.ssh/inside': 'Host from-inside\n',
    });
    expect((await list(source(root))).hosts).toEqual(['first', 'from-a', 'from-nested', 'from-b', 'middle', 'from-inside', 'last']);
  });

  it('reads every argument of one Include, a quoted path with a space among them', async () => {
    const root = tree({ '.ssh/config': 'Include one "with space/two"\n', '.ssh/one': 'Host one\n', '.ssh/with space/two': 'Host two\n' });
    expect((await list(source(root))).hosts).toEqual(['one', 'two']);
  });

  it('lists the Host lines around Match blocks and follows an Include inside one', async () => {
    const root = tree({
      '.ssh/config': ['Match host prod exec "true"', '  User deploy', '  Include matched', 'Host after-match', 'Match all', 'Host final'].join('\n'),
      '.ssh/matched': 'Host from-match\n',
    });
    expect((await list(source(root))).hosts).toEqual(['from-match', 'after-match', 'final']);
  });

  it('reads the system file after the user file, its relative Includes beside it, nested ones too, and refuses ~ there', async () => {
    const root = tree({
      '.ssh/config': 'Host mine\n',
      'etc/ssh/ssh_config': 'Host system\nInclude ssh_config.d/*\nInclude ~/.ssh/nope\n',
      'etc/ssh/ssh_config.d/x': 'Host from-system-dir\nInclude nested\n',
      'etc/ssh/nested': 'Host nested-system\n',
      '.ssh/nested': 'Host wrong-nested\n',
      '.ssh/nope': 'Host wrong-tilde\n',
    });
    const { hosts, logs } = await list(source(root, { systemConfig: path.join(root, 'etc/ssh/ssh_config') }));
    expect(hosts).toEqual(['mine', 'system', 'from-system-dir', 'nested-system']);
    expect(logs.some((line) => line.includes('Include ~/.ssh/nope skipped: `~` in a system file'))).toBe(true);
  });

  it('expands `~` and relative Includes with HOME, and reads the user file from the passwd home', async () => {
    const root = tree({
      'passwd/.ssh/config': 'Host from-passwd\nInclude ~/tilde\nInclude relative\n',
      'env-home/tilde': 'Host from-env-tilde\n',
      'env-home/.ssh/relative': 'Host from-env-relative\n',
      'passwd/tilde': 'Host wrong-tilde\n',
      'passwd/.ssh/relative': 'Host wrong-relative\n',
    });
    const config = source(path.join(root, 'passwd'), { env: { HOME: path.join(root, 'env-home') } });
    expect((await list(config)).hosts).toEqual(['from-passwd', 'from-env-tilde', 'from-env-relative']);
  });

  it('expands ${NAME}, %d, %u, %i and %% in an Include, and skips one with an unset variable or a host token', async () => {
    const root = tree({
      '.ssh/config': ['Include ${CONF}/a', 'Include %d/b', 'Include %u-%i', 'Include 100%%', 'Include ${UNSET}/c', 'Include %h.conf', 'Host after'].join('\n'),
      'conf/a': 'Host from-var\n',
      'b': 'Host from-home\n',
      '.ssh/ada-1000': 'Host from-user\n',
      '.ssh/100%': 'Host from-percent\n',
    });
    const { hosts, logs } = await list(source(root, { env: { CONF: path.join(root, 'conf') } }));
    expect(hosts).toEqual(['from-var', 'from-home', 'from-user', 'from-percent', 'after']);
    expect(logs.some((line) => line.endsWith('Include ${UNSET}/c skipped: ${UNSET} is not set'))).toBe(true);
    expect(logs.some((line) => line.endsWith('Include %h.conf skipped: %h is not known without a host'))).toBe(true);
  });

  it('globs as glob(3) does: no braces, ** as *, sets, negation, ? and no dotfiles for *', async () => {
    const root = tree({
      '.ssh/config': ['Include {a,b}.conf', 'Include d/**', 'Include s/[ab].x', 'Include s/[!ab].x', 'Include s/?.y', 'Include h/*'].join('\n'),
      '.ssh/{a,b}.conf': 'Host literal-brace\n',
      '.ssh/a.conf': 'Host wrong-a\n',
      '.ssh/d/top': 'Host top\n',
      '.ssh/d/sub/deep': 'Host wrong-deep\n',
      '.ssh/s/b.x': 'Host set\n',
      '.ssh/s/c.x': 'Host negated\n',
      '.ssh/s/z.y': 'Host question\n',
      '.ssh/h/.hidden': 'Host wrong-hidden\n',
      '.ssh/h/shown': 'Host shown\n',
    });
    expect((await list(source(root))).hosts).toEqual(['literal-brace', 'top', 'set', 'negated', 'question', 'shown']);
  });

  it('reads the home of a `~` or relative Include as glob syntax, as ssh does', async () => {
    // ssh puts the home into the glob pattern unquoted: a brace stays itself, a bracket is a set
    const root = tree({
      'h{1,2}/.ssh/config': 'Include inc\n',
      'h{1,2}/.ssh/inc': 'Host from-brace-home\n',
      'h[x]/.ssh/config': 'Include inc\n',
      'h[x]/.ssh/inc': 'Host wrong-literal-bracket\n',
      'hx/.ssh/inc': 'Host from-bracket-set\n',
    });
    expect((await list(source(path.join(root, 'h{1,2}')))).hosts).toEqual(['from-brace-home']);
    expect((await list(source(path.join(root, 'h[x]')))).hosts).toEqual(['from-bracket-set']);
  });

  it('quotes with a backslash in the POSIX flavour, and splits on it in the Windows one', async () => {
    const root = tree({ '.ssh/config': 'Include sub\\[x].conf\n', '.ssh/sub[x].conf': 'Host literal-bracket\n', '.ssh/sub/x.conf': 'Host from-set\n' });
    expect((await list(source(root, { platform: 'linux' }))).hosts).toEqual(['literal-bracket']);
    expect((await list(source(root, { platform: 'win32' }))).hosts).toEqual(['from-set']);
  });

  it('skips ~user with a log line', async () => {
    const root = tree({ '.ssh/config': 'Include ~root/x\nHost after\n' });
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['after']);
    expect(logs.some((line) => line.endsWith('Include ~root/x skipped: `~user` is not expanded'))).toBe(true);
  });

  it('logs an Include that matches nothing', async () => {
    const root = tree({ '.ssh/config': 'Include conf.d/*\nHost after\n' });
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['after']);
    expect(logs.some((line) => line.endsWith('Include conf.d/* matched no files'))).toBe(true);
  });

  it('logs and skips a file it cannot open, and lists the rest', async () => {
    const root = tree({ '.ssh/config': 'Host before\nInclude locked\nHost after\n', '.ssh/locked': 'Host wrong-locked\n' });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('locked')) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return open(file, ...rest);
    });
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['before', 'after']);
    expect(logs.some((line) => line.includes('locked: EPERM'))).toBe(true);
  });

  it('skips a folder, a file past 4 MiB and a ~/.ssh that is a file, each with a log line, and a missing file silently', async () => {
    const root = tree({ '.ssh/config': 'Include folder\nInclude big\nInclude missing\nHost after\n', '.ssh/big': `Host wrong-big\n${'#'.repeat(4 * 1024 * 1024)}` });
    fs.mkdirSync(path.join(root, '.ssh', 'folder'));
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['after']);
    expect(logs.some((line) => /folder: (not a regular file|EISDIR)$/.test(line))).toBe(true);
    expect(logs.some((line) => line.endsWith('big: larger than 4194304 bytes'))).toBe(true);
    expect(logs.some((line) => line.includes('missing:'))).toBe(false);

    const notFolder = tree({ '.ssh': 'a file\n' });
    const result = await list(source(notFolder));
    expect(result.hosts).toEqual([]);
    expect(result.logs.some((line) => /ENOTDIR|ENOENT/.test(line))).toBe(process.platform !== 'win32');
  });

  it('lists nothing when no config exists', async () => {
    expect(await list(source(tree({})))).toEqual({ hosts: [], logs: [] });
  });

  it('stops an Include loop at once, and a chain deeper than 16', async () => {
    const root = tree({ '.ssh/config': 'Host looped\nInclude config\nInclude twice\nInclude twice\n', '.ssh/twice': 'Include config\n' });
    const open = vi.spyOn(fs.promises, 'open');
    const { hosts, logs } = await list(source(root));
    expect(hosts).toEqual(['looped']);
    expect(logs.filter((line) => line.endsWith('Include loop'))).toHaveLength(3);
    expect(open).toHaveBeenCalledTimes(6);

    const chain: Record<string, string> = { '.ssh/config': 'Include f1\n' };
    for (let index = 1; index <= 17; index++) chain[`.ssh/f${index}`] = `Host h${index}\nInclude f${index + 1}\n`;
    const deep = await list(source(tree(chain)));
    expect(deep.hosts).toEqual(Array.from({ length: 16 }, (_, index) => `h${index + 1}`));
    expect(deep.logs.some((line) => line.endsWith('f17: Include nested deeper than 16'))).toBe(true);
  });

  it('writes nothing under ~/.ssh', async () => {
    const root = tree({ '.ssh/config': 'Host a\nInclude conf.d/*\n', '.ssh/conf.d/b': 'Host b\n' });
    const snapshot = (folder: string): string[] => fs.readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort().map((name) => {
      const file = path.join(folder, name);
      const stat = fs.statSync(file);
      return `${name} ${stat.mode} ${stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'folder'}`;
    });
    const before = snapshot(path.join(root, '.ssh'));
    await list(source(root));
    expect(snapshot(path.join(root, '.ssh'))).toEqual(before);
  });
});

describe('defaultSshConfigSource', () => {
  const account = { homedir: 'C:\\Users\\ada', username: 'ada', uid: -1 };

  it('reads the profile and ProgramData files on Windows, ALLUSERSPROFILE and C:\\ProgramData standing in for ProgramData', () => {
    expect(defaultSshConfigSource(account, 'win32', { ProgramData: 'D:\\Data' })).toEqual({
      userConfig: 'C:\\Users\\ada\\.ssh\\config',
      systemConfig: 'D:\\Data\\ssh\\ssh_config',
      account,
      platform: 'win32',
      env: { ProgramData: 'D:\\Data' },
    });
    expect(defaultSshConfigSource(account, 'win32', { ALLUSERSPROFILE: 'E:\\All' }).systemConfig).toBe('E:\\All\\ssh\\ssh_config');
    expect(defaultSshConfigSource(account, 'win32', {}).systemConfig).toBe('C:\\ProgramData\\ssh\\ssh_config');
  });

  it('reads the home and /etc/ssh files elsewhere', () => {
    const posix = { homedir: '/home/ada', username: 'ada', uid: 1000 };
    expect(defaultSshConfigSource(posix, 'linux', {})).toMatchObject({ userConfig: '/home/ada/.ssh/config', systemConfig: '/etc/ssh/ssh_config' });
  });
});

describe('resolveSshHops', () => {
  const G = (host: string, user: string, port: number | string, extra = ''): string => `hostname ${host}\nuser ${user}\nport ${port}\nidentityfile ~/.ssh/id_ed25519\n${extra}`;

  function hops(outputs: Record<string, string | { readonly code: number; readonly stderr: string }>, destination: SshHopsInput['destination'] = { kind: 'alias', alias: 'prod-1' }) {
    const signal = new AbortController().signal;
    const run = vi.fn(async (_ssh: string, args: readonly string[], _signal: AbortSignal) => {
      const output = outputs[args.at(-1)!] ?? { code: 255, stderr: `ssh: Could not resolve hostname ${args.at(-1)!}` };
      return typeof output === 'string' ? { code: 0, stdout: output, stderr: '' } : { code: output.code, stdout: '', stderr: output.stderr };
    });
    return { run, signal, result: resolveSshHops({ ssh: '/usr/bin/ssh', destination, configFile: '/cfg', signal, run }) };
  }

  it('reads a hop\'s HostKeyAlias and whether it connects through a ProxyCommand other than none', async () => {
    expect(await hops({ 'prod-1': G('10.0.0.5', 'deploy', 22, 'hostkeyalias prod-key\nproxycommand ssh -W %h:%p gate\n') }).result).toEqual([
      { alias: 'prod-1', hostname: '10.0.0.5', port: 22, user: 'deploy', identityFiles: ['~/.ssh/id_ed25519'], hostKeyAlias: 'prod-key', proxyCommand: true },
    ]);
    expect(await hops({ 'prod-1': G('10.0.0.5', 'deploy', 22, 'proxycommand none\n') }).result).toEqual([
      { alias: 'prod-1', hostname: '10.0.0.5', port: 22, user: 'deploy', identityFiles: ['~/.ssh/id_ed25519'] },
    ]);
  });

  it('makes each ProxyJump host a hop of its own, before the target, following only the first jump\'s own ProxyJump', async () => {
    const { run, signal, result } = hops({
      'prod-1': G('10.0.0.5', 'deploy', 2222, 'proxyjump ada@bastion,inner:2201\n'),
      bastion: G('bastion.example.com', 'ada', 22, 'proxyjump edge\n'),
      edge: G('edge.example.com', 'ada', 22),
      inner: G('inner.lan', 'ada', 2201, 'proxyjump ignored\n'),
    });
    expect((await result).map((hop) => [hop.alias, hop.hostname, hop.port, hop.user])).toEqual([
      ['edge', 'edge.example.com', 22, 'ada'],
      ['bastion', 'bastion.example.com', 22, 'ada'],
      ['inner', 'inner.lan', 2201, 'ada'],
      ['prod-1', '10.0.0.5', 2222, 'deploy'],
    ]);
    expect(run.mock.calls[1]![1]).toEqual(['-F', '/cfg', '-l', 'ada', '-G', '--', 'bastion']);
    expect(run.mock.calls.every((call) => call[2] === signal)).toBe(true);
  });

  it('fails a ProxyJump loop at its first repeat, a host jumping through itself included', async () => {
    const cycle = hops({ a: G('a.lan', 'u', 22, 'proxyjump b\n'), b: G('b.lan', 'u', 22, 'proxyjump a\n') }, { kind: 'alias', alias: 'a' });
    await expect(cycle.result).rejects.toThrow('ProxyJump loop at a');
    expect(cycle.run).toHaveBeenCalledTimes(2);
    const self = hops({ 'gw.corp': G('gw.corp', 'u', 22, 'proxyjump gw.corp\n') }, { kind: 'alias', alias: 'gw.corp' });
    await expect(self.result).rejects.toThrow('ProxyJump loop at gw.corp');
    expect(self.run).toHaveBeenCalledTimes(1);
  });

  it('runs at most 8 ssh -G queries, the target\'s included', async () => {
    const chain = (length: number): Record<string, string> => Object.fromEntries(Array.from({ length }, (_, index) => [`h${index}`, G(`h${index}.lan`, 'u', 22, index + 1 < length ? `proxyjump h${index + 1}\n` : '')]));
    expect(await hops(chain(8), { kind: 'alias', alias: 'h0' }).result).toHaveLength(8);
    const long = hops(chain(9), { kind: 'alias', alias: 'h0' });
    await expect(long.result).rejects.toThrow('more than 8 ssh hops at h8');
    expect(long.run).toHaveBeenCalledTimes(8);
  });

  it('keeps a target that resolves to the same host as its jump', async () => {
    const { result } = hops({ 'prod-1': G('same.lan', 'u', 22, 'proxyjump jump\n'), jump: G('same.lan', 'u', 22) });
    expect((await result).map((hop) => hop.alias)).toEqual(['jump', 'prod-1']);
  });

  it('names the hop, the exit and ssh\'s stderr when a query fails, and the ProxyJump that did not parse', async () => {
    await expect(hops({ 'prod-1': G('x', 'u', 22, 'proxyjump gone\n') }).result).rejects.toThrow('ssh -G gone failed (exit 255): ssh: Could not resolve hostname gone');
    await expect(hops({ 'prod-1': G('x', 'u', 22, 'proxyjump h:99999\n') }).result).rejects.toThrow('the ProxyJump h:99999 of prod-1 did not parse');
  });

  it('reads ProxyJump as ssh does: the last @ ends the user, ssh:// users percent-decoded, brackets, aliases ssh accepts', async () => {
    const { run, result } = hops({
      'prod-1': G('x', 'u', 22, 'proxyjump first.last@corp.com@bastion,ssh://user%40domain@uri:2222/,[10.0.0.1],jump+eu\n'),
      bastion: G('bastion.lan', 'first.last@corp.com', 22),
      uri: G('uri.lan', 'user@domain', 2222),
      '10.0.0.1': G('10.0.0.1', 'u', 22),
      'jump+eu': G('eu.lan', 'u', 22),
    });
    expect((await result).map((hop) => hop.alias)).toEqual(['bastion', 'uri', '10.0.0.1', 'jump+eu', 'prod-1']);
    expect(run.mock.calls.slice(1).map((call) => call[1].slice(2))).toEqual([
      ['-l', 'first.last@corp.com', '-G', '--', 'bastion'],
      ['-l', 'user@domain', '-p', '2222', '-G', '--', 'uri'],
      ['-G', '--', '10.0.0.1'],
      ['-G', '--', 'jump+eu'],
    ]);
  });

  it('follows no ProxyCommand and treats ProxyJump none as no jump', async () => {
    const { result } = hops({ 'prod-1': G('x', 'u', 22, 'proxycommand ssh -W %h:%p bastion\nproxyjump none\n') });
    expect((await result).map((hop) => hop.alias)).toEqual(['prod-1']);
  });

  it('reads ssh -G output: CRLF, the first value of a key, every IdentityFile, and only a decimal port in range', async () => {
    const { result } = hops({ 'prod-1': 'hostname first\r\nhostname second\r\nuser a b\r\nport 22\r\nidentityfile /k1\r\nidentityfile /k2\r\n' });
    expect(await result).toEqual([{ alias: 'prod-1', hostname: 'first', user: 'a b', port: 22, identityFiles: ['/k1', '/k2'] }]);
    for (const port of ['0', '65536', '0x16', '1e1', 'x']) await expect(hops({ 'prod-1': G('x', 'u', port) }).result).rejects.toThrow('ssh -G prod-1 failed (exit 0)');
    await expect(hops({ 'prod-1': 'user u\nport 22\n' }).result).rejects.toThrow('ssh -G prod-1 failed');
  });
});
