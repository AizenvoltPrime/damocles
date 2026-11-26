import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import type * as Koffi from 'koffi';
import { HOST_REATTACH_WAIT_MS, HOST_RETRY_MS } from '../../../src/desktop/daemon/terminal-host-timing';
import { AUTH_TIMEOUT_MS } from '../../../src/remote/handshake';

// a daemon's start, a page's polls and the target's own pace
const SLACK_MS = 60_000;
// the probe's unanswered list closes a stopped host's link, and the host is not responding the reattach wait after that
export const NOT_RESPONDING_MS: number = HOST_RETRY_MS + AUTH_TIMEOUT_MS + HOST_REATTACH_WAIT_MS + SLACK_MS;
// a host that answers again attaches at the next retry
export const ANSWERS_AGAIN_MS: number = HOST_RETRY_MS + AUTH_TIMEOUT_MS + SLACK_MS;
// winnt.h
const PROCESS_SUSPEND_RESUME = 0x0800;

/** The terminal's status in the shell's terminal state; undefined once no tab holds it. */
export const terminalStatus = async (shell: Page, id: string): Promise<string | undefined> =>
  (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id)?.status;

/** Stops this computer's process pid for good, as `kill -STOP` does: SIGSTOP on POSIX, NtSuspendProcess (every thread) on Windows. */
export function suspendProcess(pid: number): void {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGSTOP');
    return;
  }
  const koffi = createRequire(import.meta.url)('koffi') as typeof Koffi;
  const openProcess = koffi.load('kernel32.dll').func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)') as (access: number, inherit: number, pid: number) => unknown;
  const closeHandle = koffi.load('kernel32.dll').func('int __stdcall CloseHandle(void *handle)') as (handle: unknown) => number;
  const ntSuspendProcess = koffi.load('ntdll.dll').func('int32_t __stdcall NtSuspendProcess(void *process)') as (handle: unknown) => number;
  const handle = openProcess(PROCESS_SUSPEND_RESUME, 0, pid);
  if (handle === null) throw new Error(`OpenProcess(${pid}) failed`);
  try {
    const status = ntSuspendProcess(handle);
    if (status !== 0) throw new Error(`NtSuspendProcess(${pid}) failed with NTSTATUS 0x${(status >>> 0).toString(16)}`);
  } finally {
    closeHandle(handle);
  }
}
