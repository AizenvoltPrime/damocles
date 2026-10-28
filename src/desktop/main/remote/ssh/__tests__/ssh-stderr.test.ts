import { describe, expect, it } from 'vitest';
import { changedHostName, classifySshStderr, knownHostsRemoveCommand } from '../ssh-stderr';

const CHANGED = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'The fingerprint for the ED25519 key sent by the remote host is',
  'SHA256:2bWvYpQ7cWe0n9sZr3xTkq8Yt1Jm0Xh6Ue5d4c3b2a1.',
  'Please contact your system administrator.',
  'Add correct host key in C:\\Users\\dev\\.ssh/known_hosts to get rid of this message.',
  'Offending ED25519 key in C:\\Users\\dev\\.ssh/known_hosts:3',
  'Host key for [127.0.0.1]:2222 has changed and you have requested strict checking.',
  'Host key verification failed.',
].join('\r\n');

// the outer ssh's own lines after a ProxyJump leg failed
const JUMP_FAILED = 'kex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535\n';

describe('classifySshStderr', () => {
  it('reads a changed host key as hostKeyChanged with the known_hosts name ssh-keygen -R takes, before the verification failure', () => {
    expect(classifySshStderr(CHANGED)).toEqual({ code: 'hostKeyChanged', params: { host: '[127.0.0.1]:2222' } });
  });

  it('reads a refused or unverifiable host key as hostKeyRefused', () => {
    expect(classifySshStderr('Host key verification failed.\r\n')).toEqual({ code: 'hostKeyRefused', params: {} });
    expect(classifySshStderr('No ED25519 host key is known for prod and you have requested strict checking.\nHost key verification failed.\n')).toEqual({ code: 'hostKeyRefused', params: {} });
  });

  it('reads a refused authentication as permissionDenied', () => {
    expect(classifySshStderr('dev@127.0.0.1: Permission denied (publickey).\r\n')).toEqual({ code: 'permissionDenied', params: {} });
    expect(classifySshStderr('dev@prod: Permission denied (publickey,password,keyboard-interactive).\n')?.code).toBe('permissionDenied');
    expect(classifySshStderr('Permission denied (publickey).\n')?.code).toBe('permissionDenied');
  });

  it('reads too many authentication failures as permissionDenied', () => {
    expect(classifySshStderr('Received disconnect from 10.0.0.9 port 22:2: Too many authentication failures\nDisconnected from 10.0.0.9 port 22\n')?.code).toBe('permissionDenied');
    expect(classifySshStderr('Received disconnect from 10.0.0.9: 2: Too many authentication failures for dev\n')?.code).toBe('permissionDenied');
  });

  it('reads a name that does not resolve, in each OS\'s words', () => {
    expect(classifySshStderr('ssh: Could not resolve hostname prod-1: No such host is known.\r\n')?.code).toBe('unresolved');
    expect(classifySshStderr('ssh: Could not resolve hostname prod-1: Name or service not known\n')?.code).toBe('unresolved');
    expect(classifySshStderr('ssh: Could not resolve hostname prod-1: Temporary failure in name resolution\n')?.code).toBe('unresolved');
    expect(classifySshStderr('ssh: Could not resolve hostname prod-1: nodename nor servname provided, or not known\n')?.code).toBe('unresolved');
  });

  it('reads refused and timed out connections', () => {
    expect(classifySshStderr('ssh: connect to host 127.0.0.1 port 2222: Connection refused\r\n')?.code).toBe('refused');
    expect(classifySshStderr('kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 127.0.0.1 port 2222\r\n')?.code).toBe('refused');
    expect(classifySshStderr('kex_exchange_identification: read: Connection reset by peer\n')?.code).toBe('refused');
    expect(classifySshStderr('ssh: connect to host 10.0.0.9 port 22: Connection timed out\n')?.code).toBe('timedOut');
    expect(classifySshStderr('ssh: connect to host 10.0.0.9 port 22: Operation timed out\n')?.code).toBe('timedOut');
    expect(classifySshStderr('kex_exchange_identification: read: Connection timed out\n')?.code).toBe('timedOut');
    expect(classifySshStderr('Connection timed out during banner exchange\n')?.code).toBe('timedOut');
    expect(classifySshStderr('Timeout, server prod-1 not responding.\r\n')?.code).toBe('timedOut');
  });

  it('reads a host that cannot be reached as unreachable', () => {
    expect(classifySshStderr('ssh: connect to host 10.0.0.9 port 22: No route to host\n')).toEqual({ code: 'unreachable', params: {} });
    expect(classifySshStderr('ssh: connect to host 10.0.0.9 port 22: Network is unreachable\n')?.code).toBe('unreachable');
    expect(classifySshStderr('ssh: connect to host 10.0.0.9 port 22: Host is down\n')?.code).toBe('unreachable');
  });

  it('reads the identification failure of an OpenSSH before 8.2', () => {
    expect(classifySshStderr('ssh_exchange_identification: Connection closed by remote host\r\n')?.code).toBe('refused');
    expect(classifySshStderr('ssh_exchange_identification: read: Connection reset by peer\r\n')?.code).toBe('refused');
  });

  it('reads a close only as part of the identification exchange, never one after it', () => {
    // sshd's LoginGraceTime ending while a prompt waited, or an sshd restart
    expect(classifySshStderr('Connection closed by 127.0.0.1 port 56956\r\n')).toBeUndefined();
    expect(classifySshStderr('Connection reset by 10.0.0.9 port 22\r\n')).toBeUndefined();
  });

  it('reads a ProxyJump hop\'s failure before the close the outer ssh adds, and names a hop that refused the sign-in', () => {
    expect(classifySshStderr(`ssh: connect to host bastion port 22: Connection timed out\n${JUMP_FAILED}`)?.code).toBe('timedOut');
    expect(classifySshStderr(`ssh: connect to host bastion port 22: No route to host\n${JUMP_FAILED}`)?.code).toBe('unreachable');
    expect(classifySshStderr(`channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n${JUMP_FAILED}`)?.code).toBe('refused');
    expect(classifySshStderr(`channel 0: open failed: connect failed: Name or service not known\nstdio forwarding failed\n${JUMP_FAILED}`)?.code).toBe('unresolved');
    expect(classifySshStderr(`jump@bastion: Permission denied (publickey).\n${JUMP_FAILED}`)).toEqual({ code: 'permissionDenied', params: { hop: 'jump@bastion' } });
  });

  it('reads nothing from a banner or a remote tool whose text shares the tail', () => {
    expect(classifySshStderr('NOTICE: idle sessions are timed out after 15 minutes.\n')).toBeUndefined();
    expect(classifySshStderr('Access: Permission denied (policy) is logged.\n')).toBeUndefined();
    expect(classifySshStderr('curl: (7) Failed to connect to github.com port 443: Connection refused\n')).toBeUndefined();
    expect(classifySshStderr('wget: unable to resolve host address github.com: Name or service not known\n')).toBeUndefined();
  });

  it('names nothing for stderr that holds none of ssh\'s failures', () => {
    expect(classifySshStderr('Warning: Permanently added \'[127.0.0.1]:2222\' (ED25519) to the list of known hosts.\r\n')).toBeUndefined();
  });
});

describe('knownHostsRemoveCommand', () => {
  it('double-quotes a [host]:port name, which zsh and bash would read as a glob, and leaves a plain name bare', () => {
    expect(knownHostsRemoveCommand('[127.0.0.1]:59225')).toBe('ssh-keygen -R "[127.0.0.1]:59225"');
    expect(knownHostsRemoveCommand('prod-1.example.com')).toBe('ssh-keygen -R prod-1.example.com');
    expect(() => knownHostsRemoveCommand('-oProxyCommand=calc')).toThrow(RangeError);
    expect(() => knownHostsRemoveCommand('fe80::1%eth0')).toThrow(RangeError);
  });
});

describe('changedHostName', () => {
  it('takes a plain name or [host]:port, and refuses anything that could be an option or holds a shell metacharacter', () => {
    expect(changedHostName('Host key for prod-1.example.com has changed and')).toBe('prod-1.example.com');
    expect(changedHostName('Host key for -oProxyCommand=calc has changed')).toBeUndefined();
    expect(changedHostName('Host key for prod;rm has changed')).toBeUndefined();
  });

  it('reads the name in the DNS-spoofing warning', () => {
    const spoofing = [
      '@       WARNING: POSSIBLE DNS SPOOFING DETECTED!          @',
      'The ED25519 host key for prod-1.example.com has changed,',
      'and the key for the corresponding IP address 10.0.0.9',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      '',
    ].join('\n');
    expect(classifySshStderr(spoofing)).toEqual({ code: 'hostKeyChanged', params: { host: 'prod-1.example.com' } });
  });
});
