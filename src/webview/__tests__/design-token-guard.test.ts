import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const TOKENS_CSS = path.join(SRC, 'webview', 'styles', 'tokens.css');
// The shared webview and every desktop page (shell, pane, overlay) with the main and preload code that themes them.
const GUARDED_ROOTS = [path.join(SRC, 'webview'), path.join(SRC, 'desktop')];
const SOURCE_EXTENSIONS = new Set(['.vue', '.ts', '.css', '.html']);
const VSCODE_VARIABLE = /--vscode-[A-Za-z0-9]/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

describe('design token guard', () => {
  const files = GUARDED_ROOTS.flatMap(sourceFiles);

  it('scans the renderer sources', () => {
    expect(files).toContain(TOKENS_CSS);
    expect(files.some((file) => file.endsWith(path.join('desktop', 'main', 'theme.ts')))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });

  it('lets only tokens.css read a --vscode-* variable; everything else reads --d-*', () => {
    const offenders = files
      .filter((file) => file !== TOKENS_CSS)
      .flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) => (VSCODE_VARIABLE.test(line) ? [`${path.relative(SRC, file)}:${i + 1}`] : [])));
    expect(offenders).toEqual([]);
    expect(fs.readFileSync(TOKENS_CSS, 'utf8')).toMatch(/--d-bg: var\(--vscode-editor-background\)/);
  });
});
