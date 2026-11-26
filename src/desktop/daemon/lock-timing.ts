// The daemon lock's timing (singleton.ts), which the bridge (attach.ts) waits out for the daemon it starts, and
// the bounds of a shutdown's steps. Main reads it too, so it imports nothing that starts processes.
import { AUTH_TIMEOUT_MS } from '../../remote/handshake';

// process-identity.ts: a tool (macOS ps) that has not answered by then failed the read
export const IDENTITY_READ_TIMEOUT_MS = 5000;
// process-kill.ts: how long a signalled shell or host has to end before SIGKILL, and a forced one to go
export const KILL_GRACE_MS = 2000;

// proper-lockfile refreshes the lock's mtime this often, and another start takes over a lock older than LOCK_STALE_MS
export const LOCK_UPDATE_MS = 5_000;
export const LOCK_STALE_MS = 20_000;
// a daemon shutting down holds the lock until its last step; its core's close (3 s), the terminal hosts' end
// (terminal-hosts.ts HOST_SHUTDOWN_TIMEOUT_MS, 3 s) and the connections' end (2 s) are the steps with a limit
export const SHUTDOWN_MAX_MS = 10_000;
// Only a removal's shutdown may pass SHUTDOWN_MAX_MS, since its run folder goes: after the hosts' 3 s, a host that ignored its
// frozen shutdown is proved and then forced, as each unreachable one is meanwhile. Main's REMOVAL_CLOSE_WAIT_MS is at least this.
export const REMOVAL_SHUTDOWN_MAX_MS: number = SHUTDOWN_MAX_MS + IDENTITY_READ_TIMEOUT_MS + KILL_GRACE_MS;
// A start whose lock holder does not answer waits this long. A holder gone from this host is replaced at once; one the start
// cannot judge (another host's, or a pid in use again) turns stale within LOCK_STALE_MS + LOCK_UPDATE_MS, and a daemon
// shutting down releases the lock within SHUTDOWN_MAX_MS, or REMOVAL_SHUTDOWN_MAX_MS for a removal, keeping it fresh meanwhile.
export const LOCK_WAIT_MS: number = LOCK_STALE_MS + LOCK_UPDATE_MS + REMOVAL_SHUTDOWN_MAX_MS;
// a start holds the takeover lock for a few file operations; an older one was left by a start that died inside it
export const TAKEOVER_STALE_MS = 10_000;
// a start past the lock: the login shell's environment (shell-env.ts SHELL_ENV_TIMEOUT_MS, 10 s), the git probe and the
// endpoint within 15 s, and the adoption of the terminal hosts (terminal-hosts.ts: all at once, each attach within
// AUTH_TIMEOUT_MS, then for a host that did not attach one start identity read within IDENTITY_READ_TIMEOUT_MS)
export const DAEMON_START_MS: number = 15_000 + AUTH_TIMEOUT_MS + IDENTITY_READ_TIMEOUT_MS;
// A bridge waits this long for a daemon: its own probe of a holder that never answers, then the start it ran, whose lock wait
// may end in one more such probe.
export const ATTACH_DEADLINE_MS: number = AUTH_TIMEOUT_MS + LOCK_WAIT_MS + AUTH_TIMEOUT_MS + DAEMON_START_MS;
