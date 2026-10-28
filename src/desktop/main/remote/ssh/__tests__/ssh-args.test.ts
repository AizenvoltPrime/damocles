import { describe, expect, it } from 'vitest';
import {
  buildSshArgs, buildSshConfigQueryArgs, buildSshControlArgs, buildSshVerifyArgs, FIXED_SSH_OPTIONS, identityArgs, isSafeAlias, optionArg, SshArgumentError,
} from '../ssh-args';
import type { SshDestination } from '../ssh-command-parse';

const WIN = process.platform === 'win32';
const KEY = WIN ? 'C:\\Users\\me\\.damocles\\ssh\\id_ed25519' : '/home/me/.damocles/ssh/id_ed25519';
// Damocles' key as the IdentityFile line ssh reads back as the key
const KEY_LINE = `IdentityFile="${WIN ? 'C:/Users/me/.damocles/ssh/id_ed25519' : KEY}"`;
const SAVED: SshDestination = { kind: 'address', host: '10.0.0.9', user: 'deploy', port: 2222, options: [{ name: 'IdentitiesOnly', value: 'no' }, { name: 'IdentityFile', value: '~/.ssh/work' }] };

describe('buildSshArgs', () => {
  it('passes the fixed options, exactly one ForwardAgent=no, -- and then the destination and command', () => {
    const args = buildSshArgs({ destination: { kind: 'alias', alias: 'prod-1' }, forwardAgent: false, command: 'uname -s' });
    expect(args).toEqual([...FIXED_SSH_OPTIONS, '-o', 'ForwardAgent=no', '--', 'prod-1', 'uname -s']);
    expect(FIXED_SSH_OPTIONS).toEqual(['-T', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15', '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes']);
    expect(args.filter((arg) => arg.startsWith('ForwardAgent='))).toEqual(['ForwardAgent=no']);
  });

  it('puts -F, -l and -p first, then the fixed set, Damocles\' key and only then the saved options, so ssh keeps Damocles\' values', () => {
    const args = buildSshArgs({ configFile: 'C:\\e2e\\ssh_config', destination: SAVED, forwardAgent: false, identityFile: KEY, command: 'stage0' });
    expect(args).toEqual([
      '-F', 'C:\\e2e\\ssh_config', '-l', 'deploy', '-p', '2222', ...FIXED_SSH_OPTIONS,
      '-o', 'IdentitiesOnly=yes', '-o', KEY_LINE,
      '-o', 'IdentitiesOnly="no"', '-o', 'IdentityFile="~/.ssh/work"',
      '-o', 'ForwardAgent=no', '--', '10.0.0.9', 'stage0',
    ]);
  });

  it('gives the verify call the connection\'s order with its own options in place of the ControlMaster ones', () => {
    const verify = buildSshVerifyArgs(SAVED, 'C:\\e2e\\ssh_config', KEY);
    const connect = buildSshArgs({ configFile: 'C:\\e2e\\ssh_config', destination: SAVED, forwardAgent: false, identityFile: KEY, command: 'exit 0', controlMaster: { kind: 'off' } });
    const own = ['-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
    const fixedEnd = 6 + FIXED_SSH_OPTIONS.length;
    expect(verify).toEqual([...connect.slice(0, fixedEnd), ...own, ...connect.slice(fixedEnd + 4)]);
    expect(buildSshVerifyArgs({ kind: 'alias', alias: 'prod-1' }, undefined, KEY)).toEqual([...FIXED_SSH_OPTIONS, ...own, '-o', 'IdentitiesOnly=yes', '-o', KEY_LINE, '-o', 'ForwardAgent=no', '--', 'prod-1', 'exit 0']);
  });

  it('makes the one ForwardAgent yes when the host forwards its agent, beside the control and identity options', () => {
    const args = buildSshArgs({ destination: { kind: 'alias', alias: 'prod-1' }, forwardAgent: true, identityFile: KEY, command: 'stage0', controlMaster: { kind: 'damocles', controlPath: '/home/me/.damocles/ssh/cm/%C' } });
    expect(args).toEqual([
      ...FIXED_SSH_OPTIONS, '-o', 'ControlMaster=auto', '-o', 'ControlPath="/home/me/.damocles/ssh/cm/%C"', '-o', 'ControlPersist=10m',
      '-o', 'IdentitiesOnly=yes', '-o', KEY_LINE, '-o', 'ForwardAgent=yes', '--', 'prod-1', 'stage0',
    ]);
  });

  it('refuses an alias, host, user or port ssh could misread, and an option outside the allowlist', () => {
    const build = (destination: SshDestination) => () => buildSshArgs({ destination, forwardAgent: false, command: 'x' });
    expect(build({ kind: 'alias', alias: '-oProxyCommand=calc' })).toThrow(SshArgumentError);
    expect(build({ kind: 'address', host: '-oProxyCommand=calc', options: [] })).toThrow(SshArgumentError);
    expect(build({ kind: 'address', host: 'prod', user: '-oProxyCommand=calc', options: [] })).toThrow(SshArgumentError);
    expect(build({ kind: 'address', host: 'prod', options: [{ name: 'ProxyCommand' as 'Compression', value: 'calc' }] })).toThrow(SshArgumentError);
    expect(build({ kind: 'address', host: 'prod', options: [{ name: 'Compression', value: 'maybe' }] })).toThrow(SshArgumentError);
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(build({ kind: 'address', host: 'prod', port, options: [] }), String(port)).toThrow(SshArgumentError);
  });
});

describe('optionArg', () => {
  it('quotes every value, so a space, an apostrophe or a leading # reads back as written', () => {
    expect(optionArg('IdentityFile', "/home/o'brien/my key", 'linux')).toBe('IdentityFile="/home/o\'brien/my key"');
    expect(optionArg('IdentityFile', '#key', 'linux')).toBe('IdentityFile="#key"');
    expect(optionArg('IdentityFile', '/k/100%%/%r_key', 'darwin')).toBe('IdentityFile="/k/100%%/%r_key"');
  });

  it('turns a Windows backslash into /, so OpenSSH before and after 8.7 read the same path', () => {
    expect(optionArg('IdentityFile', "C:\\Users\\O'Brien\\key", 'win32')).toBe('IdentityFile="C:/Users/O\'Brien/key"');
    expect(optionArg('IdentityFile', '\\\\server\\share\\key', 'win32')).toBe('IdentityFile="//server/share/key"');
    expect(optionArg('IdentityFile', 'C:\\keys\\my dir\\', 'win32')).toBe('IdentityFile="C:/keys/my dir/"');
    expect(optionArg('IdentityFile', '~\\.ssh\\my key', 'win32')).toBe('IdentityFile="~/.ssh/my key"');
  });

  it('refuses a double quote, a control character, and a backslash off Windows', () => {
    for (const [value, platform] of [['a"b', 'win32'], ['a"b', 'linux'], ['/a\nb', 'linux'], ['/a\\b', 'linux'], ['/a\\b', 'darwin']] as const) expect(() => optionArg('IdentityFile', value, platform), value).toThrow(SshArgumentError);
  });
});

describe('identityArgs', () => {
  it('offers Damocles\' key as an IdentityFile line, its doubled % kept, and refuses a relative path', () => {
    expect(identityArgs(KEY)).toEqual(['-o', 'IdentitiesOnly=yes', '-o', KEY_LINE]);
    const percent = WIN ? 'C:\\Users\\a%%b\\.damocles\\ssh\\id_ed25519' : '/home/a%%b/.damocles/ssh/id_ed25519';
    expect(identityArgs(percent)[3]).toBe(`IdentityFile="${percent.replaceAll('\\', '/')}"`);
    expect(() => identityArgs('relative/key')).toThrow(SshArgumentError);
    expect(() => identityArgs(`${KEY}\n-oProxyCommand=calc`)).toThrow(SshArgumentError);
  });
});

describe('isSafeAlias', () => {
  it('takes an alias ssh reads as written and refuses an option, a user, a URI, a pattern or a control character', () => {
    for (const alias of ['prod-1', 'build.example.com', 'a'.repeat(255), 'prod_2']) expect(isSafeAlias(alias), alias).toBe(true);
    for (const alias of ['', '-oProxyCommand=x', 'a b', ' a', 'a*', 'a?', '!a', 'a\u0001', 'a\u200B', 'a'.repeat(256), 'bob@prod', 'ssh://prod:2200']) expect(isSafeAlias(alias), JSON.stringify(alias)).toBe(false);
  });
});

describe('buildSshConfigQueryArgs and buildSshControlArgs', () => {
  const address: SshDestination = { kind: 'address', host: 'prod', user: 'dev', port: 2200, options: [{ name: 'ProxyJump', value: 'jump' }] };

  it('carry the connection\'s -F, -l, -p and saved options, so ssh hashes %C the same', () => {
    expect(buildSshConfigQueryArgs(address, '/e2e/config')).toEqual(['-F', '/e2e/config', '-l', 'dev', '-p', '2200', '-o', 'ProxyJump="jump"', '-G', '--', 'prod']);
    expect(buildSshConfigQueryArgs({ kind: 'alias', alias: 'prod-1' }, undefined)).toEqual(['-G', '--', 'prod-1']);
    expect(buildSshControlArgs(address, undefined, '/home/me/.damocles/ssh/cm/%C')).toEqual(['-l', 'dev', '-p', '2200', '-o', 'ProxyJump="jump"', '-o', 'ControlPath="/home/me/.damocles/ssh/cm/%C"', '-O', 'exit', '--', 'prod']);
    expect(buildSshControlArgs({ kind: 'alias', alias: 'prod-1' }, '/e2e/config', '/a b/%C')).toEqual(['-F', '/e2e/config', '-o', 'ControlPath="/a b/%C"', '-O', 'exit', '--', 'prod-1']);
    expect(() => buildSshControlArgs({ kind: 'alias', alias: 'prod-1' }, undefined, '/a"b/%C')).toThrow(SshArgumentError);
  });
});
