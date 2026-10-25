// The machine's stable id, which keys the daemon's run folder: the hostname changes with the network on macOS, so a bridge
// keyed by it could miss the running daemon and start a second one. Only an HMAC of the id leaves this module, as systemd
// asks of applications (sd_id128_get_machine_app_specific).
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { runProcess } from '../../core/process-launcher';
import { windowsSystemTool } from '../../core/system-tools';

const RUN_FOLDER_LABEL = 'damocles-server-run-folder';
export const LINUX_MACHINE_ID_FILES: readonly string[] = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
const IOREG = '/usr/sbin/ioreg';
const QUERY_TIMEOUT_MS = 30_000;

export function parseMachineGuid(stdout: string): string | undefined {
  return /^\s*MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})\s*$/m.exec(stdout)?.[1]?.toLowerCase();
}

export function parsePlatformUuid(stdout: string): string | undefined {
  return /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(stdout)?.[1]?.toLowerCase();
}

/** The first file holding a machine id (32 lowercase hex digits); an empty or uninitialized one, as containers have, is skipped. */
export async function firstMachineIdFile(files: readonly string[] = LINUX_MACHINE_ID_FILES): Promise<string | undefined> {
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const id = text.trim();
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  }
  return undefined;
}

async function query(file: string, args: readonly string[], parse: (stdout: string) => string | undefined): Promise<string> {
  const { exit, stdout } = await runProcess({ file, args: [...args], windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, { timeoutMs: QUERY_TIMEOUT_MS });
  const id = exit?.code === 0 ? parse(stdout.toString('utf8')) : undefined;
  if (id === undefined) throw new Error(`${file} did not name this machine's id (exit ${String(exit?.code ?? 'none')})`);
  return id;
}

// Windows and macOS always have their id, so a failed read fails the caller rather than keying another run folder.
async function readMachineId(platform: NodeJS.Platform): Promise<string> {
  if (platform === 'win32') return query(windowsSystemTool('reg'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], parseMachineGuid);
  if (platform === 'darwin') return query(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], parsePlatformUuid);
  return (await firstMachineIdFile()) ?? `hostname:${os.hostname()}`;
}

let resolved: Promise<string> | undefined;

/** This machine's run folder key, read once per process: 16 hex digits of HMAC-SHA256 keyed by the machine id. */
export function machineRunKey(): Promise<string> {
  resolved ??= readMachineId(process.platform).then(runKeyOf);
  return resolved;
}

export function runKeyOf(machineId: string): string {
  return createHmac('sha256', machineId).update(RUN_FOLDER_LABEL).digest('hex').slice(0, 16);
}
