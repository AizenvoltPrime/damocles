import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// No other CI job runs Vitest on Windows, so a Windows-only test outside pr.yml windows-unit's folders never runs at all.
const ROOT = join(__dirname, '..', '..');
const WIN = /process\.platform\s*===\s*['"]win32['"]/;
const NOT_WIN = /process\.platform\s*!==\s*['"]win32['"]/;

// The argument list of the call whose `(` ends at `from`.
function callArguments(text: string, from: number): string {
  let depth = 1;
  let at = from;
  for (; at < text.length && depth > 0; at++) {
    if (text[at] === '(') depth++;
    else if (text[at] === ')') depth--;
  }
  return text.slice(from, at - 1).trim();
}

/** Whether `source` has a runIf or skipIf block that runs only on Windows; a bare `flag` or `!flag` is read through its `const`. */
export function hasWindowsOnlyBlock(source: string): boolean {
  const definitions = new Map<string, string>();
  for (const match of source.matchAll(/const (\w+)\s*=\s*([^;\n]+)/g)) if (!definitions.has(match[1]!)) definitions.set(match[1]!, match[2]!);
  for (const match of source.matchAll(/\b(?:describe|it|test)(?:\.\w+)*\.(runIf|skipIf)\(/g)) {
    const raw = callArguments(source, match.index + match[0].length);
    const flag = /^(!?)(\w+)$/.exec(raw);
    const condition = flag && definitions.has(flag[2]!) ? `${flag[1]}(${definitions.get(flag[2]!)})` : raw;
    const negated = condition.startsWith('!(');
    const onWindows = match[1] === 'runIf' ? (negated ? NOT_WIN : WIN) : (negated ? WIN : NOT_WIN);
    if (onWindows.test(condition)) return true;
  }
  return false;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    return entry.name.endsWith('.test.ts') ? [relative(ROOT, full).replaceAll('\\', '/')] : [];
  });
}

describe('pr.yml windows-unit', () => {
  it('reads a Windows-only block in each form the suite uses, and no POSIX-only one', () => {
    expect(hasWindowsOnlyBlock("it.runIf(process.platform === 'win32')('x', () => {});")).toBe(true);
    expect(hasWindowsOnlyBlock('describe.runIf(process.platform === "win32")("x", () => {});')).toBe(true);
    expect(hasWindowsOnlyBlock("it.skipIf(process.platform !== 'win32' || !fs.existsSync(GIT_BASH))('x', () => {});")).toBe(true);
    expect(hasWindowsOnlyBlock("const posix = process.platform !== 'win32';\nit.runIf(!posix)('x', () => {});")).toBe(true);
    expect(hasWindowsOnlyBlock("const windowsOnly = shell === undefined || process.platform !== 'win32';\nit.skipIf(windowsOnly)('x', () => {});")).toBe(true);
    expect(hasWindowsOnlyBlock("it.skipIf(process.platform === 'win32')('x', () => {});")).toBe(false);
    expect(hasWindowsOnlyBlock("const posixOnly = process.platform === 'win32';\nit.skipIf(posixOnly)('x', () => {});")).toBe(false);
    expect(hasWindowsOnlyBlock("it.runIf(process.platform !== 'win32')('x', () => {});")).toBe(false);
  });

  it('runs every test file that has a Windows-only block', () => {
    const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'pr.yml'), 'utf8')) as { jobs: Record<string, { 'runs-on': string; steps: { run?: string }[] }> };
    const job = workflow.jobs['windows-unit']!;
    expect(job['runs-on']).toMatch(/^windows-/);
    const command = job.steps.map((step) => step.run?.trim()).find((run) => run?.startsWith('npx vitest run '));
    const folders = command!.slice('npx vitest run '.length).split(/\s+/);
    const windowsOnly = [...testFiles(join(ROOT, 'src')), ...testFiles(join(ROOT, 'scripts'))].filter((file) => hasWindowsOnlyBlock(readFileSync(join(ROOT, file), 'utf8')));
    expect(windowsOnly.length).toBeGreaterThan(0);
    expect(windowsOnly.filter((file) => !folders.some((folder) => file.startsWith(`${folder}/`)))).toEqual([]);
  });
});
