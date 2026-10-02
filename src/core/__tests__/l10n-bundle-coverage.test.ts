import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** `t()` falls back to the English literal, so a message missing from a bundle shows a Greek user English instead of failing. */

const ROOT = path.join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

/** A JS string literal body with its escapes resolved. */
function decode(body: string): string {
  return body.replace(/\\(.)/g, (_match, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));
}

/** Every message passed to the host `t()` as a string literal, or as a same-file string constant. */
function translatedMessages(): Map<string, string> {
  const messages = new Map<string, string>();
  const files = [...sourceFiles(path.join(ROOT, 'src', 'core')), ...sourceFiles(path.join(ROOT, 'src', 'vscode'))];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*\/l10n['"]/.test(source)) continue;
    const where = path.relative(ROOT, file);
    for (const match of source.matchAll(/(?<![\w.$])t\(\s*(['"])((?:[^\\\n]|\\.)*?)\1/g)) messages.set(decode(match[2]!), where);
    for (const match of source.matchAll(/(?<![\w.$])t\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g)) {
      const constant = new RegExp(`const ${match[1]}\\s*=\\s*(['"])((?:[^\\\\\\n]|\\\\.)*?)\\1`).exec(source);
      if (!constant) throw new Error(`${where}: t(${match[1]}) does not name a string constant in the same file`);
      messages.set(decode(constant[2]!), where);
    }
  }
  return messages;
}

describe('extension l10n bundles', () => {
  const messages = translatedMessages();

  it('finds the messages it checks (guards the scan itself from matching nothing)', () => {
    expect(messages.size).toBeGreaterThan(100);
    expect(messages.has('Tool information isn\'t available for "{0}".')).toBe(true);
  });

  it.each(['bundle.l10n.json', 'bundle.l10n.el.json'])('%s has every message src/core and src/vscode translate', (bundle) => {
    const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', bundle), 'utf8')) as Record<string, string>;
    const missing = [...messages].filter(([message]) => !Object.hasOwn(table, message)).map(([message, file]) => `${file}: ${message}`);

    expect(missing).toEqual([]);
  });
});
