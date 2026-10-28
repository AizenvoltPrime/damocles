// What ssh's stderr says went wrong, as a failure code the overlay localizes. Each pattern is anchored to the start of a line
// ssh itself prints, so a server banner or other text in the tail does not match.
import type { SshFailureCode } from '../../../preload/overlay-channels';

export interface SshStderrFailure {
  readonly code: SshFailureCode;
  readonly params: Readonly<Record<string, string>>;
}

// what `ssh-keygen -R` accepts and a clipboard command may hold: one token, not an option, and no `%` (cmd expands it)
const KNOWN_HOSTS_NAME = /^[A-Za-z0-9[\]:._-]{1,255}$/;
const MAX_HOP_CHARS = 255;

/** The known_hosts name ssh printed for a changed key (`[host]:port` off port 22), when it is one `ssh-keygen -R` can take. */
export function changedHostName(stderr: string): string | undefined {
  const name = /^Host key for (\S+) has changed/m.exec(stderr)?.[1] ?? /^The (?:\S+) host key for (\S+) has changed/m.exec(stderr)?.[1];
  return name !== undefined && KNOWN_HOSTS_NAME.test(name) && !name.startsWith('-') ? name : undefined;
}

/**
 * The command that removes a changed key, as the modal shows and copies it. A `[host]:port` name is double-quoted, since
 * zsh and bash read brackets as a glob; double quotes keep it literal in sh, zsh, PowerShell and cmd alike, and
 * KNOWN_HOSTS_NAME admits no character any of them expands inside them.
 */
export function knownHostsRemoveCommand(host: string): string {
  if (!KNOWN_HOSTS_NAME.test(host) || host.startsWith('-')) throw new RangeError('not a known_hosts name ssh-keygen -R takes');
  return `ssh-keygen -R ${/[[\]]/.test(host) ? `"${host}"` : host}`;
}

// A connect's errno text: ssh's own `connect to host`, or a ProxyJump host's `channel N: open failed: connect failed`.
const CONNECT_ERROR = /^(?:ssh: )?connect to host \S+ port \S+: (.+?)\r?$|^channel \d+: open failed: connect failed: (.+?)\r?$/m;
// The identification exchange failing, which ssh before 8.2 prefixes ssh_ and a ProxyJump leg that failed also ends with.
const EXCHANGE_FAILED = /^(?:kex|ssh)_exchange_identification: (.+?)\r?$/m;

function errnoFailure(text: string): SshFailureCode | undefined {
  if (/^Connection refused/.test(text)) return 'refused';
  if (/^(?:Connection|Operation) timed out/.test(text)) return 'timedOut';
  if (/^(?:No route to host|Network is unreachable|Host is down)/.test(text)) return 'unreachable';
  if (/^(?:Name or service not known|Temporary failure in name resolution|nodename nor servname provided|No address associated with hostname|No such host is known)/.test(text)) return 'unresolved';
  return undefined;
}

/** The first of ssh's failure messages in stderr, most specific first; undefined when stderr names none. */
export function classifySshStderr(stderr: string): SshStderrFailure | undefined {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|^Host key for \S+ has changed/m.test(stderr)) {
    const host = changedHostName(stderr);
    return { code: 'hostKeyChanged', params: host !== undefined ? { host } : {} };
  }
  if (/^Host key verification failed\./m.test(stderr) || /^No \S+ host key is known for .* and you have requested strict checking/m.test(stderr)) return { code: 'hostKeyRefused', params: {} };
  const exchange = EXCHANGE_FAILED.exec(stderr);
  const denied = /^(?:(\S+@\S+): )?Permission denied \(/m.exec(stderr);
  if (denied) {
    // a denial before an identification exchange that never finished came from a jump host on the way, not the target
    const hop = exchange && denied[1] !== undefined ? denied[1].slice(0, MAX_HOP_CHARS) : undefined;
    return { code: 'permissionDenied', params: hop !== undefined ? { hop } : {} };
  }
  if (/^(?:Received disconnect from .*)?Too many authentication failures/m.test(stderr)) return { code: 'permissionDenied', params: {} };
  if (/^(?:ssh: )?Could not resolve hostname /m.test(stderr)) return { code: 'unresolved', params: {} };
  const connect = CONNECT_ERROR.exec(stderr);
  const connectCode = connect && errnoFailure(connect[1] ?? connect[2]!);
  if (connectCode) return { code: connectCode, params: {} };
  if (/^Connection timed out during banner exchange|^Timeout, server \S+ not responding\./m.test(stderr)) return { code: 'timedOut', params: {} };
  if (exchange) {
    const reason = exchange[1]!;
    if (/timed out/.test(reason)) return { code: 'timedOut', params: {} };
    // a port that accepts and then closes (a proxy or load balancer in front of a stopped sshd) is unreachable as a refusal is
    if (/^Connection closed by remote host|^read: Connection reset by peer/.test(reason)) return { code: 'refused', params: {} };
  }
  return undefined;
}
