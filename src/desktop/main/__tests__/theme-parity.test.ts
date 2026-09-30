import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() } }));

import { DARK_THEME, LIGHT_THEME, themeCss } from '../theme';

const WEBVIEW_ROOT = path.resolve(__dirname, '..', '..', '..', 'webview');
const SOURCE_EXTENSIONS = new Set(['.vue', '.ts', '.css', '.html']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

/** Every `--vscode-*` custom property the webview reads through var(). */
function referencedVariables(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(WEBVIEW_ROOT)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/var\(\s*(--vscode-[A-Za-z0-9-]+)/g)) {
      if (!found.has(match[1]!)) found.set(match[1]!, path.relative(WEBVIEW_ROOT, file));
    }
  }
  return found;
}

describe('desktop theme parity with the webview', () => {
  const referenced = referencedVariables();

  it('finds the webview references at all', () => {
    // Guards the scan itself: a moved webview root would otherwise make every palette check vacuous.
    expect(referenced.size).toBeGreaterThanOrEqual(40);
  });

  it.each([
    ['dark', DARK_THEME],
    ['light', LIGHT_THEME],
  ] as const)('the %s palette defines every referenced --vscode-* variable with a value', (kind, palette) => {
    const missing = [...referenced].filter(([name]) => !palette[name as `--vscode-${string}`]?.trim()).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
    const css = themeCss(kind);
    for (const name of referenced.keys()) expect(css).toContain(`${name}:`);
  });

  it('dark and light define the same variable set', () => {
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(Object.keys(DARK_THEME).sort());
  });
});
