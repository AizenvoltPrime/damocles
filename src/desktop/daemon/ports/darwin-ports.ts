// Listening TCP sockets on macOS: `lsof -nP -iTCP -sTCP:LISTEN -a -u <uid> -Fpcn` on the daemon's launcher, and the parent
// chain from `ps`, as gopsutil reads macOS sockets (net_unix.go, BSD-3, THIRD-PARTY-NOTICES.md).
import { runProcess, type RunOutput, type SpawnSpec } from '../../../core/process-launcher';
import { posixToolAsync } from '../../../core/system-tools';
import { loopbackOf } from './linux-ports';
import type { PortCandidate } from './ports-messages';
import { describeProcess, type ProcessEntry } from './process-label';

const LSOF = '/usr/sbin/lsof';
const SCAN_TIMEOUT_MS = 10_000;

export interface LsofSocket {
  readonly pid: number;
  readonly name: string;
  readonly port: number;
  readonly bindAddress: string;
  readonly family: 4 | 6;
}

/** lsof's -F fields: `p<pid>` and `c<command>` open a process, `n<address>:<port>` names one of its sockets. */
export function parseLsof(text: string): LsofSocket[] {
  const sockets: LsofSocket[] = [];
  let pid: number | undefined;
  let name = '';
  for (const line of text.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = /^\d+$/.test(value) ? Number(value) : undefined;
      name = '';
    } else if (field === 'c') {
      name = value;
    } else if (field === 'n' && pid !== undefined) {
      const colon = value.lastIndexOf(':');
      const port = Number(value.slice(colon + 1));
      if (colon < 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      const address = value.slice(0, colon);
      // '*' is the wildcard of either family; IPv6 addresses come bracketed
      const v6 = address.startsWith('[') && address.endsWith(']');
      const bindAddress = address === '*' ? '0.0.0.0' : v6 ? address.slice(1, -1) : address;
      sockets.push({ pid, name, port, bindAddress, family: v6 ? 6 : 4 });
    }
  }
  return sockets;
}

/** `ps -o pid=,ppid=,args=` rows: the command line stays whole after the two numbers. */
export function parsePs(text: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[3]!.trim();
    const pid = Number(match[1]);
    table.set(pid, { pid, ppid: Number(match[2]), name: command.split(' ')[0] ?? command, ...(command.length > 0 ? { command } : {}) });
  }
  return table;
}

export interface DarwinScanDeps {
  readonly run?: (spec: SpawnSpec, options: { readonly timeoutMs: number }) => Promise<RunOutput>;
  readonly ps?: () => Promise<string | undefined>;
  readonly uid?: number;
}

async function output(run: NonNullable<DarwinScanDeps['run']>, file: string, args: readonly string[]): Promise<string> {
  const result = await run({ file, args, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: SCAN_TIMEOUT_MS });
  if (result.exit === null) throw new Error(`${file} did not finish within ${SCAN_TIMEOUT_MS} ms`);
  // lsof exits 1 when it found no socket
  if (result.exit.code !== 0 && result.stdout.length > 0) throw new Error(`${file} exited ${result.exit.code ?? result.exit.signal}: ${result.stderr.toString('utf8').slice(0, 512)}`);
  return result.stdout.toString('utf8');
}

export async function scanDarwinListeners(deps: DarwinScanDeps = {}): Promise<PortCandidate[]> {
  const run = deps.run ?? runProcess;
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const sockets = parseLsof(await output(run, LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid), '-Fpcn']));
  if (sockets.length === 0) return [];
  const ps = await (deps.ps ?? (() => posixToolAsync('ps')))();
  const table = ps === undefined ? new Map<number, ProcessEntry>() : parsePs(await output(run, ps, ['-o', 'pid=,ppid=,args=', '-U', String(uid)]));
  // lsof's command name is the executable's, which a row shows over the first word of its arguments
  const named = new Map(table);
  for (const socket of sockets) {
    const listed = table.get(socket.pid);
    named.set(socket.pid, { pid: socket.pid, ppid: listed?.ppid ?? 0, name: socket.name, ...(listed?.command !== undefined ? { command: listed.command } : {}) });
  }
  const seen = new Set<string>();
  return sockets.flatMap((socket) => {
    // a socket shared by forked workers is listed once per process
    const id = `${socket.bindAddress}:${socket.port}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const described = describeProcess(socket.pid, named);
    return [{ port: socket.port, bindAddress: socket.bindAddress, family: socket.family, host: loopbackOf(socket.bindAddress, socket.family), pid: socket.pid, ...(described ? { process: described } : {}) }];
  });
}
