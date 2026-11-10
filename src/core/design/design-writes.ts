// Core's writes to one design folder, or to one state folder, run one at a time in call order (D65). In-process is enough:
// one chat's process holds a design, and its subagents run in that process.
import * as path from 'node:path';

const lanes = new Map<string, Promise<unknown>>();

// Case-insensitive volumes spell one folder many ways.
function laneKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/**
 * Runs `fn` once every write queued before it on `dir`'s lane settled. `fn` never calls another `withDesignWrite` on the same
 * lane, which would wait for itself.
 */
export function withDesignWrite<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = laneKey(dir);
  const run = (lanes.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.then(() => undefined, () => undefined);
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return run;
}
