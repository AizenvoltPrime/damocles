// node scripts/theme-validator-smoke.ts
// Runs the built theme validator (npm run build:theme-validator) on the fixtures of scripts/theme-validator-fixtures.ts and
// on a call with no file, and fails unless each exit code and printed verdict is the one the store's CI relies on.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(ROOT, 'dist', 'theme-validate.js');

// Exit 0 accepted, 1 refused, 2 a usage or internal error (src/desktop/theme-validate/cli.ts).
const CASES: ReadonlyArray<{ file?: string; exit: number; ok?: boolean }> = [
  { file: 'valid.damocles-theme', exit: 0, ok: true },
  { file: 'flashing.damocles-theme', exit: 1, ok: false },
  { file: 'over-limit.damocles-theme', exit: 1, ok: false },
  { exit: 2 },
];

function node(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (run.error) throw run.error;
  return run;
}

/** Why a run's exit code and stdout are not what `expected` names; undefined when they are. */
function problem(expected: (typeof CASES)[number], status: number | null, stdout: string): string | undefined {
  if (status !== expected.exit) return `exit ${status}, expected ${expected.exit}`;
  if (expected.ok === undefined) return stdout === '' ? undefined : 'printed on stdout, where only a verdict belongs';
  let verdict: { ok?: unknown; errors?: unknown; entry?: unknown };
  try {
    verdict = JSON.parse(stdout) as typeof verdict;
  } catch {
    return 'stdout is not one JSON verdict';
  }
  if (verdict.ok !== expected.ok) return `verdict ok is ${String(verdict.ok)}, expected ${expected.ok}`;
  if (expected.ok) return verdict.entry === undefined ? 'an accepted verdict has no entry' : undefined;
  return Array.isArray(verdict.errors) && verdict.errors.length > 0 ? undefined : 'a refused verdict names no error';
}

const dir = mkdtempSync(join(tmpdir(), 'theme-validator-smoke'));
let failed = 0;
try {
  const fixtures = node([join(ROOT, 'scripts', 'theme-validator-fixtures.ts'), dir]);
  if (fixtures.status !== 0) throw new Error(`theme-validator-fixtures.ts exited ${fixtures.status}: ${fixtures.stderr}`);
  for (const expected of CASES) {
    const name = expected.file ?? '(no file)';
    const { status, stdout, stderr } = node([VALIDATOR, ...(expected.file === undefined ? [] : [join(dir, expected.file), '--thumbs', join(dir, 'thumbs')])]);
    const why = problem(expected, status, stdout);
    console.log(`${why === undefined ? 'PASS' : 'FAIL'}  ${name}  ${why ?? `exit ${status}`}`);
    if (why !== undefined) {
      failed += 1;
      console.error(stderr);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed === 0 ? 0 : 1;
