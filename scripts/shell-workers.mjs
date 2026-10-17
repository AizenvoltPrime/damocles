// The workers the desktop shell build may ship (docs/invariants.md, "Only the desktop chat panel page and the shell page allow
// workers"): Monaco's editor, JSON and TypeScript workers from this checkout's node_modules, and the shell's own quick diff
// and merge workers, matched by their full paths so no other file of the same name passes.
import { resolve } from 'node:path';

export const SHELL_OWN_WORKERS = ['src/desktop/shell/editor/quick-diff/quick-diff.worker.ts', 'src/desktop/shell/editor/merge/merge.worker.ts'];

/** A test of a worker chunk's entry module path (Rollup's facadeModuleId) against root's allowed workers. */
export function shellWorkerTest(root) {
  // Windows paths compare without regard to case or separator
  const key = (path) => (process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path);
  const own = new Set(SHELL_OWN_WORKERS.map((file) => key(resolve(root, file))));
  const monaco = `${key(resolve(root, 'node_modules/monaco-editor/esm/vs'))}/`;
  return (entry) => {
    const path = key(entry);
    return own.has(path) || (path.startsWith(monaco) && /\/(?:editor|json|ts)\.worker\.js$/.test(path));
  };
}
