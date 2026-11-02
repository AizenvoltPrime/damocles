// Whether WSL forwards a distro's loopback ports to this computer, decided by a probe instead of by reading settings
// (docs/invariants.md "Ports and the remote browser"): the daemon listens on a random loopback port in the distro and answers
// a random nonce; the same nonce read from this computer's 127.0.0.1 on that port means WSL forwards it.
import * as net from 'node:net';
import * as path from 'node:path';
import { loadImageNameReader, loadWin32Api, parseTcp4Table, parseTcp6Table, readTcpTable, type TableRow } from '../../../daemon/ports/win32-ports';
import { accepts, type LoopbackAddress } from '../ports/tunnels';

export const PROBE_TIMEOUT_MS = 2000;
// WSL's relay, which holds a forwarded port on this computer in NAT mode
const WSL_RELAY = 'wslrelay.exe';
const AF_INET = 2;
const AF_INET6 = 23;
// the nonce's hex and its newline; an answer past this is no nonce
const MAX_ANSWER_BYTES = 64;

export type ProbeVerdict = { readonly forwarded: true } | { readonly forwarded: false; readonly reason: 'wrongAnswer' | 'refused' | 'timeout' | 'failed' };

// WSL's localhost relay forwards a new loopback listener up to about 1 s after it listens, so a refusal inside the window
// connects again after this gap
export const PROBE_ATTEMPT_GAP_MS = 100;

/**
 * Connects to this computer's 127.0.0.1:port and compares the first line it answers with nonce, all within timeoutMs from the
 * first attempt. A refusal is no verdict until the window ends; an answer, a wrong one included, or any other error ends it.
 */
export function probeLoopback(port: number, nonce: string, timeoutMs: number = PROBE_TIMEOUT_MS, connect: (port: number) => net.Socket = (target) => net.connect({ host: '127.0.0.1', port: target })): Promise<ProbeVerdict> {
  return new Promise<ProbeVerdict>((resolve) => {
    let socket: net.Socket | undefined;
    let gap: NodeJS.Timeout | undefined;
    let refused = false;
    let settled = false;
    const settle = (verdict: ProbeVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(gap);
      socket?.destroy();
      resolve(verdict);
    };
    // a connect that hangs counts against the same deadline
    const deadline = setTimeout(() => settle({ forwarded: false, reason: refused ? 'refused' : 'timeout' }), timeoutMs);
    const attempt = (): void => {
      const current = connect(port);
      socket = current;
      let received = Buffer.alloc(0);
      const judge = (): void => settle(received.toString('utf8').trim() === nonce ? { forwarded: true } : { forwarded: false, reason: 'wrongAnswer' });
      current.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.includes(0x0a) || received.length > MAX_ANSWER_BYTES) judge();
      });
      current.on('end', judge);
      current.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNREFUSED') {
          settle({ forwarded: false, reason: 'failed' });
          return;
        }
        refused = true;
        current.destroy();
        if (!settled) gap = setTimeout(attempt, PROBE_ATTEMPT_GAP_MS);
      });
    };
    attempt();
  });
}

/**
 * Whether this computer's loopback accepts a connection on port within timeoutMs of the first attempt. WSL's relay takes a
 * new listener's port up to about 1 s after it listens, so a refusal connects again after PROBE_ATTEMPT_GAP_MS.
 */
export async function acceptedWithin(host: LoopbackAddress, port: number, timeoutMs: number = PROBE_TIMEOUT_MS, accept: (host: LoopbackAddress, port: number) => Promise<boolean> = accepts): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await accept(host, port)) return true;
    if (Date.now() + PROBE_ATTEMPT_GAP_MS > end) return false;
    await new Promise((resolve) => setTimeout(resolve, PROBE_ATTEMPT_GAP_MS));
  }
}

export type PortHolder = 'none' | 'wslRelay' | 'other';

export interface WindowsListeners {
  // every listening TCP socket on this computer, of every user
  rows(): readonly TableRow[];
  // the owning process's image path, undefined when it cannot be read
  imagePath(pid: number): string | undefined;
}

/**
 * Who listens on port on this computer: no one, only WSL's relay, or another process, whose port a WSL server cannot take
 * over. A listener whose image cannot be read counts as another process.
 */
export function windowsPortHolder(port: number, listeners: WindowsListeners): PortHolder {
  const holders = listeners.rows().filter((row) => row.port === port);
  if (holders.length === 0) return 'none';
  const relayOnly = holders.every((row) => {
    const image = listeners.imagePath(row.pid);
    return image !== undefined && path.win32.basename(image).toLowerCase() === WSL_RELAY;
  });
  return relayOnly ? 'wslRelay' : 'other';
}

/** This computer's listeners through the GetExtendedTcpTable reader the daemon uses on Windows, and QueryFullProcessImageNameW. */
export function systemWindowsListeners(): WindowsListeners {
  const api = loadWin32Api();
  const imagePath = loadImageNameReader();
  return {
    rows: () => [...parseTcp4Table(readTcpTable(api, AF_INET)), ...parseTcp6Table(readTcpTable(api, AF_INET6))],
    imagePath,
  };
}
