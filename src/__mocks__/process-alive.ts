import * as fs from 'node:fs';

/**
 * Whether a process the test started still runs. A zombie still answers signal 0 until its parent reaps it, and an orphan's
 * new parent (init or a subreaper) reaps it on its own schedule, so on Linux the state in /proc decides.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}
