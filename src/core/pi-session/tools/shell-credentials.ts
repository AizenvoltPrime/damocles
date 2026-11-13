import { AsyncLocalStorage } from 'node:async_hooks';
import type { LaunchedProcess } from '../../process-launcher';

/** One shell call's git credential takeover (docs/invariants.md "GitHub and GitLab accounts"), registered before its shell starts. */
export interface ShellCredentialLease {
  /** Set over the shell's environment, every other spelling of a name dropped on Windows. */
  readonly env: Readonly<Record<string, string>>;
  /** The started shell takes the registration over: it ends with the shell, or with the session job when the shell left a job running. */
  heldBy(shell: LaunchedProcess): void;
  /** Ends the registration unless a shell took it over. */
  release(): void;
}

export type ShellCredentials = (toolCallId: string) => Promise<ShellCredentialLease | undefined>;

// pi's shell definitions build the environment and start the shell several calls below execute, which names the tool call
const callLease = new AsyncLocalStorage<ShellCredentialLease>();

/** Runs one shell call with its own lease, released once the call ends unless its shell took it over. */
export async function withShellCredentials<T>(credentials: ShellCredentials | undefined, toolCallId: string, run: () => Promise<T>): Promise<T> {
  const lease = await credentials?.(toolCallId);
  if (lease === undefined) return run();
  try {
    return await callLease.run(lease, run);
  } finally {
    lease.release();
  }
}

/** The lease of the shell call running in this async context. */
export function currentShellLease(): ShellCredentialLease | undefined {
  return callLease.getStore();
}
