// The daemon's logs, in the run folder's logs/ (one writer per machine on a shared home). control.logs.read reads one
// of them by name, read-only, and only from that folder.
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LOG_NAME, MAX_LOG_READ_BYTES, type LogEntry } from './control-messages';

export const DAEMON_LOG = 'daemon';

// POSIX opens refuse a link swapped in after the lstat; Windows has no O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

export async function listLogs(logsDir: string): Promise<LogEntry[]> {
  const entries = await fs.readdir(logsDir, { withFileTypes: true });
  const logs: LogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue;
    const stat = await fs.lstat(path.join(logsDir, entry.name));
    logs.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return logs;
}

/** At most length bytes of the log from offset; name is one segment the control contract checked against LOG_NAME. */
export async function readLog(logsDir: string, name: string, offset: number, length: number): Promise<{ bytes: Uint8Array; size: number }> {
  if (!LOG_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a log name`);
  const file = path.join(logsDir, name);
  if (path.dirname(file) !== logsDir) throw new Error(`${name} is outside the log folder`);
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`${name} is not a log file`);
  const handle = await fs.open(file, READ_FLAGS);
  try {
    const { size } = await handle.stat();
    const wanted = Math.max(0, Math.min(length, MAX_LOG_READ_BYTES, size - offset));
    const bytes = new Uint8Array(wanted);
    let filled = 0;
    while (filled < wanted) {
      const { bytesRead } = await handle.read(bytes, filled, wanted - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { bytes: bytes.subarray(0, filled), size };
  } finally {
    await handle.close();
  }
}
