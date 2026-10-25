import type { HostRequest as FormatterHostRequest } from '../formatter-host/protocol';
import type { HostRequest as PtyHostRequest } from '../pty-host/protocol';

/** How the pty host ended: its exit code, the reason the starter gave for an abnormal exit, and the last error it printed. */
export interface PtyHostExit {
  readonly code: number;
  readonly reason: string | null;
  readonly error: string | null;
}

/** The pty host process as its owner sees it; only its messages and how it ended are read. */
export interface PtyHostProcess {
  postMessage(message: PtyHostRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exit: PtyHostExit) => void): void;
  kill(): void;
}

/** One root's formatter host process as its owner sees it. */
export interface FormatterHostProcess {
  postMessage(message: FormatterHostRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/**
 * Starts the workspace's host processes: main's utility processes locally, the daemon's forked children on a target. Each
 * host reads its parent through parentChannel() and gets the login environment without ELECTRON_* variables.
 */
export interface HostStarters {
  startPtyHost(): PtyHostProcess;
  // with its working folder at root, the real path of the project root it formats
  startFormatterHost(root: string): FormatterHostProcess;
}
