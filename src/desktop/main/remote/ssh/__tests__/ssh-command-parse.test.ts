import { describe, expect, it } from 'vitest';
import { checkSavedAddress, isAllowedSshOption, parseJumpList, parseSshCommand, splitShellWords } from '../ssh-command-parse';

const parsed = (input: string, platform: NodeJS.Platform = 'linux') => {
  const result = parseSshCommand(input, platform);
  if (!result.ok) throw new Error(`refused ${result.refused}: ${result.reason}`);
  return result.destination;
};

const refused = (input: string, platform: NodeJS.Platform = 'linux') => {
  const result = parseSshCommand(input, platform);
  return result.ok ? undefined : { refused: result.refused, reason: result.reason };
};

describe('parseSshCommand destinations', () => {
  it('takes user@host[:port], ssh://user@host:port and bracketed IPv6', () => {
    expect(parsed('deploy@10.0.0.9')).toEqual({ kind: 'address', host: '10.0.0.9', user: 'deploy', options: [] });
    expect(parsed('deploy@prod-1.example.com:2222')).toEqual({ kind: 'address', host: 'prod-1.example.com', user: 'deploy', port: 2222, options: [] });
    expect(parsed('ssh://dev@prod:2200')).toEqual({ kind: 'address', host: 'prod', user: 'dev', port: 2200, options: [] });
    expect(parsed('dev@[fe80::1]:22')).toEqual({ kind: 'address', host: 'fe80::1', user: 'dev', port: 22, options: [] });
    expect(parsed('dev@[fe80::1]')).toEqual({ kind: 'address', host: 'fe80::1', user: 'dev', options: [] });
    expect(parsed('prod')).toEqual({ kind: 'address', host: 'prod', options: [] });
  });

  it('takes a bare IPv6 address whole, with a zone, and refuses colons that are no address', () => {
    expect(parsed('fe80::1')).toEqual({ kind: 'address', host: 'fe80::1', options: [] });
    expect(parsed('dev@fe80::1%eth0')).toEqual({ kind: 'address', host: 'fe80::1%eth0', user: 'dev', options: [] });
    expect(parsed('prod:2222')).toEqual({ kind: 'address', host: 'prod', port: 2222, options: [] });
    for (const input of ['::::', '1:2:3:4:5:6:7:8:9:10', ':.:']) expect(refused(input)).toEqual({ refused: 'host', reason: 'destination' });
  });

  it('splits user@host at the last @, and an ssh:// URI at its first @ with the user percent-decoded and ;params dropped', () => {
    expect(parsed('first.last@corp.com@bastion')).toEqual({ kind: 'address', host: 'bastion', user: 'first.last@corp.com', options: [] });
    expect(parsed('ssh://user%40domain;fingerprint=x@prod:2200/')).toEqual({ kind: 'address', host: 'prod', user: 'user@domain', port: 2200, options: [] });
    for (const input of ['ssh://a@b@prod', 'ssh://%zz@prod', 'ssh://a%00b@prod', 'ssh://@prod', '@prod', 'prod/', 'ssh://prod/path']) expect(parseSshCommand(input).ok).toBe(false);
  });

  it('names the part of a destination that failed', () => {
    expect(refused('me@host:99999')).toEqual({ refused: 'port', reason: 'destination' });
    expect(refused('me@host:abc')).toEqual({ refused: 'port', reason: 'destination' });
    expect(refused('münchen.de')).toEqual({ refused: 'host', reason: 'destination' });
    expect(refused(`${'a'.repeat(254)}`)).toEqual({ refused: 'host', reason: 'destination' });
    expect(parsed(`${'a'.repeat(253)}`).host).toHaveLength(253);
    expect(refused('ssh -- -x@prod')).toEqual({ refused: 'user', reason: 'destination' });
    expect(refused('ssh -- -oProxyCommand=calc')).toEqual({ refused: 'host', reason: 'destination' });
    expect(refused('ssh -')).toEqual({ refused: 'host', reason: 'destination' });
    expect(refused('ssh --')).toEqual({ refused: 'destination', reason: 'destination' });
    expect(refused('ssh -p 22')).toEqual({ refused: 'destination', reason: 'destination' });
  });

  it('refuses a user ssh refuses or could pass to a shell, and keeps the characters it takes', () => {
    for (const user of ['DOMAIN\\me', '"o\'brien"', 'a$(calc)', 'a;b', 'a`id`', '"a|b"', 'a&b', '"a<b"', 'a{b}']) {
      expect(refused(`ssh -l ${user} prod`), user).toEqual({ refused: '-l', reason: 'value' });
    }
    expect(refused('"o\'brien@prod"')).toEqual({ refused: 'user', reason: 'destination' });
    for (const user of ['a%b', 'a+b', 'a,b', 'a#b', 'a!b', 'first.last@corp']) expect(parsed(`ssh -l ${user} prod`).user).toBe(user);
  });

  it('takes a pasted ssh command with -l, -p, -i and -J, attached or separate', () => {
    expect(parsed('ssh -l deploy -p 2222 -i ~/.ssh/id_ed25519 -J jump@bastion:22,hop2 prod')).toEqual({
      kind: 'address', host: 'prod', user: 'deploy', port: 2222,
      options: [{ name: 'IdentityFile', value: '~/.ssh/id_ed25519' }, { name: 'ProxyJump', value: 'jump@bastion:22,hop2' }],
    });
    expect(parsed('/usr/bin/ssh -p2222 -ldeploy -i/k/id -Jhop prod')).toEqual({
      kind: 'address', host: 'prod', user: 'deploy', port: 2222, options: [{ name: 'IdentityFile', value: '/k/id' }, { name: 'ProxyJump', value: 'hop' }],
    });
    expect(parsed('ssh -- dev@prod')).toEqual({ kind: 'address', host: 'prod', user: 'dev', options: [] });
    expect(parsed('ssh prod -p 22')).toEqual({ kind: 'address', host: 'prod', port: 22, options: [] });
  });

  it('recognizes ssh.exe, any case, and a path to it, after a prompt or PowerShell\'s call operator', () => {
    for (const input of ['ssh.exe me@host', 'SSH me@host', 'Ssh.exe me@host', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe me@host', '"C:\\Program Files\\OpenSSH\\ssh.exe" me@host', '$ ssh me@host', '> ssh me@host', '& "C:\\Windows\\System32\\OpenSSH\\ssh.exe" me@host']) {
      expect(parsed(input, 'win32'), input).toEqual({ kind: 'address', host: 'host', user: 'me', options: [] });
    }
  });

  it('shows a ProxyJump hop exactly as written', () => {
    expect(parsed('ssh -J "ops@bastion.example.com:2022" dev@prod').options).toEqual([{ name: 'ProxyJump', value: 'ops@bastion.example.com:2022' }]);
  });

  it('takes every allowlisted -o option, in Key=Value, Key Value, Key = Value and attached forms, values as written', () => {
    const options = parsed([
      'ssh',
      `-o 'IdentityFile="/home/me/.ssh/id ed25519"'`, '-o IdentitiesOnly=yes', '-o "ProxyJump = bastion"',
      '-oAddressFamily=inet6', '-o "Compression yes"', '-o PreferredAuthentications=publickey,keyboard-interactive', 'prod',
    ].join(' ')).options;
    expect(options).toEqual([
      { name: 'IdentityFile', value: '/home/me/.ssh/id ed25519' }, { name: 'IdentitiesOnly', value: 'yes' }, { name: 'ProxyJump', value: 'bastion' },
      { name: 'AddressFamily', value: 'inet6' }, { name: 'Compression', value: 'yes' }, { name: 'PreferredAuthentications', value: 'publickey,keyboard-interactive' },
    ]);
  });

  it('matches -o keywords case-insensitively and stores the case variants ssh takes in lower case', () => {
    expect(parsed('ssh -o identitiesonly=yes prod').options).toEqual([{ name: 'IdentitiesOnly', value: 'yes' }]);
    expect(parsed('ssh -o IdentitiesOnly=TRUE -o Compression=Yes -o AddressFamily=INET prod').options).toEqual([
      { name: 'IdentitiesOnly', value: 'yes' }, { name: 'Compression', value: 'yes' }, { name: 'AddressFamily', value: 'inet' },
    ]);
    expect(parsed('ssh -o IdentitiesOnly=False prod').options).toEqual([{ name: 'IdentitiesOnly', value: 'no' }]);
    // ssh refuses Compression=true, and matches authentication methods exactly
    expect(refused('ssh -o Compression=true prod')).toEqual({ refused: 'Compression', reason: 'value' });
    expect(refused('ssh -o PreferredAuthentications=PublicKey prod')).toEqual({ refused: 'PreferredAuthentications', reason: 'value' });
  });

  it('maps -4, -6 and -C onto AddressFamily and Compression, bundled or not', () => {
    expect(parsed('ssh -4 prod').options).toEqual([{ name: 'AddressFamily', value: 'inet' }]);
    expect(parsed('ssh -6C prod').options).toEqual([{ name: 'AddressFamily', value: 'inet6' }, { name: 'Compression', value: 'yes' }]);
    expect(parsed('ssh -Cp22 prod')).toEqual({ kind: 'address', host: 'prod', port: 22, options: [{ name: 'Compression', value: 'yes' }] });
    expect(refused('ssh -vp 22 prod')).toEqual({ refused: '-v', reason: 'option' });
  });
});

describe('parseSshCommand settings given twice', () => {
  // ssh keeps the first value per route and ranks the routes, so two values for one setting are refused rather than ranked
  it.each([
    ['ssh -p 2222 -o Port=2200 host', 'Port'],
    ['ssh -o Port=2200 -p 2222 host', '-p'],
    ['ssh -l alice -o User=bob host', 'User'],
    ['ssh -o User=bob alice@host', 'User'],
    ['ssh -l bob alice@host', '-l'],
    ['ssh -p 22 host:23', '-p'],
    ['ssh -o Port=2200 ssh://u@host:2222', 'Port'],
    ['ssh -p 22 -p 2200 host', '-p'],
    ['ssh -l a -l b host', '-l'],
    ['ssh -J a -J b host', '-J'],
    ['ssh -J a -J a host', '-J'],
    ['ssh -J a -o ProxyJump=a host', 'ProxyJump'],
    ['ssh -o ProxyJump=b -J b host', '-J'],
    ['ssh -4 -6 host', '-6'],
    ['ssh -o AddressFamily=inet6 -4 host', '-4'],
    ['ssh -C -o Compression=no host', 'Compression'],
    ['ssh -o IdentitiesOnly=yes -o IdentitiesOnly=no host', 'IdentitiesOnly'],
  ])('refuses %s, naming %s', (input, name) => {
    expect(refused(input)).toEqual({ refused: name, reason: 'conflict' });
  });

  it('folds -o User and -o Port into the user and port, and takes agreeing duplicates once', () => {
    expect(parsed('ssh -o User=bob -o Port=2200 prod')).toEqual({ kind: 'address', host: 'prod', user: 'bob', port: 2200, options: [] });
    expect(parsed('ssh -l dev -o User=dev dev@prod -p 22 -o Port=022 -C -o Compression=yes')).toEqual({ kind: 'address', host: 'prod', user: 'dev', port: 22, options: [{ name: 'Compression', value: 'yes' }] });
    expect(parsed('ssh -i /a -i /b prod').options).toEqual([{ name: 'IdentityFile', value: '/a' }, { name: 'IdentityFile', value: '/b' }]);
  });
});

describe('parseSshCommand paths as ssh reads them', () => {
  it('keeps the backslashes of an unquoted Windows path, a UNC path and ~\\', () => {
    expect(parsed('ssh -i C:\\Users\\me\\.ssh\\id_ed25519 me@host', 'win32').options).toEqual([{ name: 'IdentityFile', value: 'C:\\Users\\me\\.ssh\\id_ed25519' }]);
    expect(parsed('ssh -i "\\\\server\\share\\key" me@host', 'win32').options).toEqual([{ name: 'IdentityFile', value: '\\\\server\\share\\key' }]);
    expect(parsed('ssh -i \\\\server\\share\\key me@host', 'win32').options).toEqual([{ name: 'IdentityFile', value: '\\\\server\\share\\key' }]);
    expect(parsed('ssh -i ~\\.ssh\\key me@host', 'win32').options).toEqual([{ name: 'IdentityFile', value: '~\\.ssh\\key' }]);
    expect(parsed('ssh -i "C:\\Users\\O\'Brien\\key" me@host', 'win32').options).toEqual([{ name: 'IdentityFile', value: "C:\\Users\\O'Brien\\key" }]);
  });

  it('reads an -o value as ssh splits a config line: its quotes, and \\\\ as one backslash', () => {
    expect(parsed('ssh -o \'IdentityFile "~/my key"\' prod').options).toEqual([{ name: 'IdentityFile', value: '~/my key' }]);
    expect(parsed('ssh -o "IdentityFile=C:\\Users\\me\\key" prod', 'win32').options).toEqual([{ name: 'IdentityFile', value: 'C:\\Users\\me\\key' }]);
    expect(parsed('ssh -o IdentityFile=\\\\server\\share\\key prod', 'win32').options).toEqual([{ name: 'IdentityFile', value: '\\server\\share\\key' }]);
    // ssh: "extra arguments at end of line"
    expect(refused('ssh -o \'IdentityFile "~/a" ~/b\' prod')).toEqual({ refused: 'IdentityFile', reason: 'value' });
    expect(refused('ssh -o "IdentityFile=/home/me/.ssh/id ed25519" prod')).toEqual({ refused: 'IdentityFile', reason: 'value' });
    expect(refused('ssh -o \'IdentityFile "~/a\' prod')).toEqual({ refused: 'IdentityFile', reason: 'quotes' });
    expect(refused('ssh -o \'IdentityFile #x\' prod')).toEqual({ refused: 'IdentityFile', reason: 'missing' });
  });

  it('refuses an identity file ssh would resolve against its working folder, and takes ~, none, %d and ${}', () => {
    expect(refused('ssh -i key.pem ec2-user@host')).toEqual({ refused: '-i', reason: 'relativePath' });
    expect(refused('ssh -o IdentityFile=.ssh/id prod')).toEqual({ refused: 'IdentityFile', reason: 'relativePath' });
    expect(refused('ssh -i $HOME/.ssh/id prod')).toEqual({ refused: '-i', reason: 'relativePath' });
    expect(refused('ssh -i C:key prod', 'win32')).toEqual({ refused: '-i', reason: 'relativePath' });
    for (const file of ['~/.ssh/id', 'none', '%d/.ssh/id', '${HOME}/.ssh/id', '/home/me/.ssh/%r_key', '/k/100%%']) expect(parsed(`ssh -i '${file}' prod`).options).toEqual([{ name: 'IdentityFile', value: file }]);
    // %U is no IdentityFile token: ssh ends its run on it
    expect(refused('ssh -i %USERPROFILE%\\.ssh\\id prod', 'win32')).toEqual({ refused: '-i', reason: 'value' });
    // off Windows a backslash reads differently in -o before and after OpenSSH 8.7
    expect(refused('ssh -i \'/k/a\\b\' prod')).toEqual({ refused: '-i', reason: 'value' });
  });
});

describe('parseSshCommand refusals', () => {
  it.each([
    ['ssh -o LocalCommand=calc prod', 'LocalCommand'],
    ['ssh -o PermitLocalCommand=yes prod', 'PermitLocalCommand'],
    ['ssh -o PKCS11Provider=/tmp/evil.so prod', 'PKCS11Provider'],
    ['ssh -o SecurityKeyProvider=/tmp/evil.so prod', 'SecurityKeyProvider'],
    ['ssh -o KnownHostsCommand=calc prod', 'KnownHostsCommand'],
    ['ssh -o "Match exec calc" prod', 'Match exec'],
    ['ssh -o ProxyCommand="nc %h %p" prod', 'ProxyCommand'],
    ['ssh -oproxycommand=calc prod', 'ProxyCommand'],
    ['ssh -o ProxyCommand prod', 'ProxyCommand'],
    ['ssh -o RemoteCommand=bash prod', 'RemoteCommand'],
    ['ssh -o StrictHostKeyChecking=no prod', 'StrictHostKeyChecking=no'],
    ['ssh -o UserKnownHostsFile=/dev/null prod', 'UserKnownHostsFile'],
    ['ssh -o ForwardAgent=yes prod', 'ForwardAgent'],
  ])('refuses %s, naming %s', (input, name) => {
    expect(refused(input)).toEqual({ refused: name, reason: 'option' });
  });

  it.each([
    ['ssh -F /tmp/config prod', '-F'],
    ['ssh -F/tmp/config prod', '-F'],
    ['ssh -A prod', '-A'],
    ['ssh -L 8080:localhost:80 prod', '-L'],
    ['ssh -R 9000:localhost:22 prod', '-R'],
    ['ssh -D 1080 prod', '-D'],
    ['ssh -W host:22 prod', '-W'],
    ['ssh -v prod', '-v'],
    ['-x@prod', '-x'],
    ['ssh --help prod', '--help'],
  ])('refuses the flag in %s, naming %s', (input, name) => {
    expect(refused(input)).toEqual({ refused: name, reason: 'option' });
  });

  it('refuses the keepalive and timeout options Damocles sets, in any form', () => {
    for (const [input, name] of [['ssh -o ServerAliveInterval=0 prod', 'ServerAliveInterval'], ['ssh -o serveralivecountmax=1 prod', 'ServerAliveCountMax'], ['ssh -o ConnectTimeout=30s prod', 'ConnectTimeout']] as const) {
      expect(refused(input)).toEqual({ refused: name, reason: 'fixed' });
    }
  });

  it('refuses a remote command after the destination', () => {
    expect(refused('ssh prod rm -rf /')).toEqual({ refused: 'command', reason: 'command' });
    expect(refused('ssh -- prod uname')).toEqual({ refused: 'command', reason: 'command' });
    expect(refused('ssh prod -- uname')).toEqual({ refused: 'command', reason: 'command' });
  });

  it('refuses values an allowed option does not take', () => {
    expect(refused('ssh -p 70000 prod')).toEqual({ refused: '-p', reason: 'value' });
    expect(refused('ssh -p -1 prod')).toEqual({ refused: '-p', reason: 'value' });
    expect(refused('ssh -l -oProxyCommand=calc prod')).toEqual({ refused: '-l', reason: 'value' });
    expect(refused('ssh -o Compression=maybe prod')).toEqual({ refused: 'Compression', reason: 'value' });
    expect(refused('ssh -o PreferredAuthentications=none prod')).toEqual({ refused: 'PreferredAuthentications', reason: 'value' });
    expect(refused('ssh -i -key prod')).toEqual({ refused: '-i', reason: 'value' });
    expect(refused('ssh -J -oProxyCommand=calc prod')).toEqual({ refused: '-J', reason: 'value' });
    expect(refused('ssh -J "a,-oProxyCommand=x" prod')).toEqual({ refused: '-J', reason: 'value' });
    expect(refused('ssh -J "a, b" prod')).toEqual({ refused: '-J', reason: 'value' });
    expect(refused('ssh -J "o\'brien@jump" prod')).toEqual({ refused: '-J', reason: 'value' });
    // ssh splits an unbracketed jump host at its first colon
    expect(refused('ssh -J fe80::1 prod')).toEqual({ refused: '-J', reason: 'value' });
    expect(parsed('ssh -J [fe80::1]:22 prod').options).toEqual([{ name: 'ProxyJump', value: '[fe80::1]:22' }]);
  });

  it('reports a missing value as missing, never as a refused value, so the dialog waits while it is typed', () => {
    expect(refused('ssh -p')).toEqual({ refused: '-p', reason: 'missing' });
    expect(refused('ssh -o Port= prod')).toEqual({ refused: 'Port', reason: 'missing' });
    expect(refused('ssh -o IdentityFile= prod')).toEqual({ refused: 'IdentityFile', reason: 'missing' });
    expect(refused('ssh -o "" prod')).toEqual({ refused: '-o', reason: 'missing' });
  });

  it('refuses unclosed quotes, an input past its bound or on two lines, and trims the ends first', () => {
    expect(refused('ssh "prod')).toEqual({ refused: 'input', reason: 'quotes' });
    expect(refused('ssh prod\nwhoami')).toEqual({ refused: 'input', reason: 'input' });
    expect(refused('ssh prod\0')).toEqual({ refused: 'input', reason: 'input' });
    expect(refused(`ssh ${'a'.repeat(4093)}`)).toEqual({ refused: 'input', reason: 'input' });
    expect(parsed('ssh me@host\n')).toEqual({ kind: 'address', host: 'host', user: 'me', options: [] });
  });

  it('drops a shell comment and refuses a word processor\'s dashes and quotes', () => {
    expect(parsed('ssh me@host # the build box')).toEqual({ kind: 'address', host: 'host', user: 'me', options: [] });
    expect(refused('ssh \u2013p 22 prod')).toEqual({ refused: '\u2013', reason: 'typography' });
    expect(refused('ssh -i \u2018/k/a b\u2019 prod')).toEqual({ refused: '\u2018', reason: 'typography' });
    expect(parsed("ssh -i /home/o\u2019brien/key prod").options).toEqual([{ name: 'IdentityFile', value: '/home/o\u2019brien/key' }]);
  });
});

describe('splitShellWords', () => {
  it('splits as a POSIX shell does, except that a backslash escapes only whitespace or a quote', () => {
    expect(splitShellWords(`ssh -o 'User=a b' -o "Port=22" a\\ b "x\\"y" 'it''s'`)).toEqual(['ssh', '-o', 'User=a b', '-o', 'Port=22', 'a b', 'x"y', 'its']);
    expect(splitShellWords('C:\\Users\\me "\\\\server\\share" \'a\\b\' a"b c"d\tx \\$HOME')).toEqual(['C:\\Users\\me', '\\\\server\\share', 'a\\b', 'ab cd', 'x', '\\$HOME']);
    expect(splitShellWords("'' x")).toEqual(['', 'x']);
    expect(splitShellWords('a\\')).toEqual(['a\\']);
    expect(splitShellWords('a#b # c')).toEqual(['a#b']);
    expect(splitShellWords('"a')).toBeUndefined();
    expect(splitShellWords("'a")).toBeUndefined();
  });
});

describe('isAllowedSshOption', () => {
  it('checks the name and value as the parser stores them', () => {
    expect(isAllowedSshOption({ name: 'Compression', value: 'yes' })).toBe(true);
    for (const option of [
      { name: 'ProxyCommand', value: 'calc' }, { name: 'User', value: 'dev' }, { name: 'Port', value: '22' }, { name: 'ServerAliveInterval', value: '15' },
      { name: 'IdentityFile', value: '"x' }, { name: 'IdentityFile', value: '-x' }, { name: 'IdentityFile', value: 'rel/key' }, { name: 'IdentityFile', value: '' },
      { name: 'IdentityFile', value: `/${'a'.repeat(1024)}` }, { name: 'IdentityFile', value: '/a\u0007' }, { name: 'IdentitiesOnly', value: 'maybe' },
      { name: 'IdentitiesOnly', value: 'true' }, { name: 'ProxyJump', value: 'a,-oProxyCommand=x' }, { name: 'ProxyJump', value: 'a, b' }, { name: 'ProxyJump', value: 'fe80::1' },
    ]) expect(isAllowedSshOption(option, 'linux'), JSON.stringify(option)).toBe(false);
    for (const option of [{ name: 'ProxyJump', value: 'none' }, { name: 'ProxyJump', value: 'a@b:22,[fe80::1]:2222,ssh://c@d' }, { name: 'IdentityFile', value: '/k/id' }]) expect(isAllowedSshOption(option, 'linux'), JSON.stringify(option)).toBe(true);
    expect(isAllowedSshOption({ name: 'IdentityFile', value: 'C:\\k\\id' }, 'win32')).toBe(true);
    expect(isAllowedSshOption({ name: 'IdentityFile', value: 'C:\\k\\id' }, 'linux')).toBe(false);
  });
});

describe('parseJumpList', () => {
  it('splits hops as ssh does, an unbracketed host at its first colon', () => {
    expect(parseJumpList('a@b:22,[fe80::1]:2222,c')).toEqual([{ user: 'a', host: 'b', port: 22 }, { host: 'fe80::1', port: 2222 }, { host: 'c' }]);
    expect(parseJumpList('fe80::1')).toBeUndefined();
    expect(parseJumpList('a,b:x')).toBeUndefined();
  });
});

describe('checkSavedAddress', () => {
  it('folds a saved User or Port option that agrees, and drops the options Damocles sets', () => {
    expect(checkSavedAddress({ host: 'h', options: [{ name: 'User', value: 'bob' }, { name: 'Port', value: '2200' }, { name: 'ServerAliveInterval', value: '0' }, { name: 'ConnectTimeout', value: '99' }, { name: 'Compression', value: 'yes' }] }, 'linux'))
      .toEqual({ ok: true, destination: { kind: 'address', host: 'h', user: 'bob', port: 2200, options: [{ name: 'Compression', value: 'yes' }] }, dropped: ['ServerAliveInterval', 'ConnectTimeout'] });
    expect(checkSavedAddress({ host: 'h', user: 'bob', port: 22, options: [{ name: 'User', value: 'bob' }, { name: 'Port', value: '22' }] }, 'linux'))
      .toEqual({ ok: true, destination: { kind: 'address', host: 'h', user: 'bob', port: 22, options: [] }, dropped: [] });
  });

  it('refuses, naming it, a saved part that would change who or where ssh connects if it were left out', () => {
    expect(checkSavedAddress({ host: 'h', user: 'alice', options: [{ name: 'User', value: 'bob' }] }, 'linux')).toEqual({ ok: false, setting: 'User' });
    expect(checkSavedAddress({ host: 'h', port: 22, options: [{ name: 'Port', value: '2200' }] }, 'linux')).toEqual({ ok: false, setting: 'Port' });
    expect(checkSavedAddress({ host: 'h', user: 'DOMAIN\\me', options: [] }, 'linux')).toEqual({ ok: false, setting: 'User' });
    expect(checkSavedAddress({ host: 'h', options: [{ name: 'IdentityFile', value: 'key.pem' }] }, 'linux')).toEqual({ ok: false, setting: 'IdentityFile' });
    expect(checkSavedAddress({ host: 'h', options: [{ name: 'ProxyJump', value: "o'brien@j" }] }, 'linux')).toEqual({ ok: false, setting: 'ProxyJump' });
    expect(checkSavedAddress({ host: 'h', options: [{ name: 'ProxyCommand', value: 'evil' }] }, 'linux')).toEqual({ ok: false, setting: 'ProxyCommand' });
    expect(checkSavedAddress({ host: '-oProxyCommand=x', options: [] }, 'linux')).toEqual({ ok: false, setting: 'host' });
  });
});
