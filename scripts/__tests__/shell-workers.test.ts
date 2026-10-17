import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_OWN_WORKERS, shellWorkerTest } from '../shell-workers.mjs';

const root = path.resolve(__dirname, '..', '..');
const allowed = shellWorkerTest(root);

describe('the shell build\'s worker allowlist', () => {
  it('admits the shell\'s own workers and Monaco\'s editor, JSON and TypeScript workers of this checkout', () => {
    for (const file of SHELL_OWN_WORKERS) expect(allowed(path.join(root, file))).toBe(true);
    expect(allowed(path.join(root, 'node_modules/monaco-editor/esm/vs/editor/common/services/editor.worker.js'))).toBe(true);
    expect(allowed(path.join(root, 'node_modules/monaco-editor/esm/vs/language/json/json.worker.js'))).toBe(true);
  });

  it('refuses a file elsewhere whose path only ends like an allowed one', () => {
    expect(allowed(path.join(root, 'vendor', 'src/desktop/shell/editor/quick-diff/quick-diff.worker.ts'))).toBe(false);
    expect(allowed(path.join(path.dirname(root), 'elsewhere', 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'))).toBe(false);
    expect(allowed(path.join(root, 'node_modules/monaco-editor/esm/vs/language/css/css.worker.js'))).toBe(false);
  });
});
