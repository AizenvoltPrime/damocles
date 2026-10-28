// The daemon lock's timing (singleton.ts), which a bridge (attach.ts, stage1-windows.ps1) waits out for the daemon it starts.
import { AUTH_TIMEOUT_MS } from '../../remote/handshake';

// proper-lockfile refreshes the lock's mtime this often, and another start takes over a lock older than LOCK_STALE_MS
export const LOCK_UPDATE_MS = 5_000;
export const LOCK_STALE_MS = 20_000;
// a daemon shutting down holds the lock until its last step; its core's close (3 s), the pty host's (2 s) and the
// connections' end (2 s) are the steps with a limit
export const SHUTDOWN_MAX_MS = 10_000;
// A start whose lock holder does not answer waits this long. A holder gone from this host is replaced at once; one the start
// cannot judge (another host's, or a pid in use again) turns stale within LOCK_STALE_MS + LOCK_UPDATE_MS, and a daemon
// shutting down releases the lock within SHUTDOWN_MAX_MS.
export const LOCK_WAIT_MS: number = LOCK_STALE_MS + LOCK_UPDATE_MS + SHUTDOWN_MAX_MS;
// a start holds the takeover lock for a few file operations; an older one was left by a start that died inside it
export const TAKEOVER_STALE_MS = 10_000;
// a start past the lock: the login shell's environment (shell-env.ts SHELL_ENV_TIMEOUT_MS, 10 s), the git probe, the endpoint
export const DAEMON_START_MS = 15_000;
// A bridge waits this long for a daemon: its own probe of a holder that never answers, then the start it ran, whose lock wait
// may end in one more such probe.
export const ATTACH_DEADLINE_MS: number = AUTH_TIMEOUT_MS + LOCK_WAIT_MS + AUTH_TIMEOUT_MS + DAEMON_START_MS;
