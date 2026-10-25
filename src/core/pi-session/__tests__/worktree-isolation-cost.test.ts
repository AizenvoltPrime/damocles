import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeIsolationBlock, type WorktreeIsolation } from '../worktree-isolation';

const calls = vi.hoisted(() => ({ canonical: [] as string[], parsed: [] as string[], cmdLines: [] as string[], fsReads: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const native = ((p: string) => (calls.fsReads.push(`realpath ${p}`), actual.realpathSync.native(p))) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args)) as typeof actual.realpathSync, { native });
  const lstatSync = ((p: string) => (calls.fsReads.push(`lstat ${p}`), actual.lstatSync(p))) as typeof actual.lstatSync;
  const readlinkSync = ((p: string) => (calls.fsReads.push(`readlink ${p}`), actual.readlinkSync(p))) as typeof actual.readlinkSync;
  return { ...actual, default: { ...actual, realpathSync, lstatSync, readlinkSync }, realpathSync, lstatSync, readlinkSync };
});
vi.mock('../../canonical-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../canonical-path')>();
  return { ...actual, canonicalPath: (...args: Parameters<typeof actual.canonicalPath>) => (calls.canonical.push(args[0]), actual.canonicalPath(...args)) };
});
vi.mock('../readonly-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../readonly-shell')>();
  return { ...actual, parseShellStructure: (text: string, depth?: number) => (calls.parsed.push(text), actual.parseShellStructure(text, depth)) };
});
vi.mock('../cmd-structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cmd-structure')>();
  return { ...actual, parseCmdLine: (...args: Parameters<typeof actual.parseCmdLine>) => (calls.cmdLines.push(args[0].command), actual.parseCmdLine(...args)) };
});

const root = path.resolve('/dam-iso-cost');
const iso: WorktreeIsolation = {
  workingFolder: path.join(root, 'wt'),
  projectPath: path.join(root, 'project'),
  repositoryRoot: path.join(root, 'project'),
  otherWorktrees: [path.join(root, 'other')],
  homeDir: path.join(root, 'home'),
  environment: {},
};

// A loop list as long as the check reads item by item.
const ITEMS = Array.from({ length: 32 }, (_, k) => `d${k}`);

describe('worktree isolation file system cost', () => {
  beforeEach(() => {
    calls.canonical.length = 0;
  });

  it('touches no path for a tool it does not check', () => {
    expect(worktreeIsolationBlock('Read', { file_path: path.join(root, 'project', 'a.ts') }, iso)).toBeUndefined();
    expect(worktreeIsolationBlock('Bash', { description: 'no command' }, iso)).toBeUndefined();
    expect(calls.canonical).toEqual([]);
  });

  it('resolves each path once per check', () => {
    expect(worktreeIsolationBlock('Bash', { command: 'git status; git status; cd src; git status; cd ..; git status' }, iso)).toBeUndefined();
    expect(calls.canonical.length).toBeGreaterThan(0);
    expect(new Set(calls.canonical).size).toBe(calls.canonical.length);
  });

  // The site in the Invoke-Expression text invalidates the first pass, so the check walks the command again.
  it('resolves each path once across the passes a check takes', () => {
    const command = `$n = 'w'; $wt = '${iso.workingFolder}'; Set-Location $wt; git status; iex "\`$\${n}t = 'src'"; Set-Location src; git status`;
    expect(worktreeIsolationBlock('PowerShell', { command }, iso)).toContain('computed');
    expect(calls.canonical.length).toBeGreaterThan(0);
    expect(new Set(calls.canonical).size).toBe(calls.canonical.length);
  });

  // Unbounded, these walk the innermost body 32,768 times; each walk resolves a new `$a/$b/$c`, so the paths count the
  // walks, which the 256-walk budget bounds.
  it('blocks nested loops past the walk budget', () => {
    const quoted = ITEMS.map((item) => `'${item}'`).join(',');
    const bash = `for a in ${ITEMS.join(' ')}; do for b in ${ITEMS.join(' ')}; do for c in ${ITEMS.join(' ')}; do git -C "$a/$b/$c" status; done; done; done`;
    const ps = `foreach ($a in ${quoted}) { foreach ($b in ${quoted}) { foreach ($c in ${quoted}) { git -C "$a/$b/$c" status } } }`;
    for (const [tool, command] of [['Bash', bash], ['PowerShell', ps]] as const) {
      calls.canonical.length = 0;
      expect(worktreeIsolationBlock(tool, { command }, iso)).toContain('loop bodies');
      expect(calls.canonical.length).toBeLessThanOrEqual(256);
    }
  });

  // Each pass of these bodies returns where it started, so the places stay few and each folder resolves once.
  it('follows a 32-item loop that pushes and pops, and nested loops that change directory, resolving each folder once', () => {
    const eight = ITEMS.slice(0, 8).join(' ');
    const rows = [
      ['PowerShell', `foreach ($d in ${ITEMS.map((item) => `'${item}'`).join(',')}) { Push-Location $d; git status; Pop-Location }; git status`],
      ['Bash', `for d in ${ITEMS.join(' ')}; do pushd "$d" && git status; popd; done; git status`],
      ['Bash', `for a in ${eight}; do pushd "$a"; for b in ${eight}; do (cd "$b" && git status); done; popd; done; git status`],
    ] as const;
    for (const [tool, command] of rows) {
      calls.canonical.length = 0;
      expect(worktreeIsolationBlock(tool, { command }, iso), command).toBeUndefined();
      expect(new Set(calls.canonical).size).toBe(calls.canonical.length);
    }
  });

  // The places a loop reaches share their prefixes, which one check reads once.
  describe('reads the file system once per path for a whole check, though many paths share a prefix', () => {
    const loops = (into: string) => [
      ['Bash', `for d in ${ITEMS.join(' ')}; do pushd "${into}$d" && pwd; popd; done; git status`],
      ['Bash', `for d in ${ITEMS.slice(0, 6).join(' ')}; do (cd "${into}$d" && pwd); done; git status`],
      ['PowerShell', `foreach ($d in ${ITEMS.map((item) => `'${into}${item}'`).join(',')}) { Push-Location $d; pwd; Pop-Location }; git status`],
    ] as const;
    const readsOf = (tool: 'Bash' | 'PowerShell', command: string, layout: WorktreeIsolation): string[] => {
      calls.fsReads.length = 0;
      expect(worktreeIsolationBlock(tool, { command }, layout), command).toBeUndefined();
      return [...calls.fsReads];
    };
    let temp: string | undefined;
    afterEach(() => {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
      temp = undefined;
    });

    it('where no path exists, and the next check reads them again', () => {
      for (const [tool, command] of loops('')) {
        const reads = readsOf(tool, command, iso);
        expect(reads.length, command).toBeGreaterThan(0);
        expect(new Set(reads).size, command).toBe(reads.length);
        expect(readsOf(tool, command, iso), command).toEqual(reads);
      }
    });

    // Resolving a missing place reads up to its longest existing prefix, here through a junction inside the worktree.
    it('where the places lie under an existing prefix reached through a link', () => {
      temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-iso-cost-')));
      const layout: WorktreeIsolation = { ...iso, workingFolder: path.join(temp, 'wt'), projectPath: path.join(temp, 'project'), repositoryRoot: path.join(temp, 'project'), otherWorktrees: [] };
      fs.mkdirSync(path.join(layout.workingFolder, 'src', 'deep'), { recursive: true });
      fs.mkdirSync(layout.projectPath, { recursive: true });
      fs.symlinkSync(path.join(layout.workingFolder, 'src'), path.join(layout.workingFolder, 'link'), 'junction');
      for (const [tool, command] of loops('link/deep/')) {
        const reads = readsOf(tool, command, layout);
        expect(reads.some((read) => read.startsWith('realpath ') && read.endsWith(path.join('link', 'deep'))), command).toBe(true);
        expect(new Set(reads).size, command).toBe(reads.length);
      }
    });
  });

  // Every walk of the body reaches the same nested texts, which a check parses once.
  it('parses each nested text once per check, however often loops and passes reach it', () => {
    const items = ITEMS.join(' ');
    // The second row's eval adds a site of a name read before it, so the check walks the command a second time.
    const rows = [
      ['Bash', `for d in ${items}; do bash -c 'git status && cd src'; eval 'git status'; cmd /d /c "git status"; done; git status`, undefined],
      ['Bash', `n=w; wt=src; for d in ${items}; do bash -c 'git status'; git -C "$wt" status; eval "\${n}t=src"; done`, 'computed'],
      ['PowerShell', `foreach ($d in ${items.split(' ').map((item) => `'${item}'`).join(',')}) { bash -c 'git status'; iex 'git status'; cmd /d /c "git status" }`, undefined],
    ] as const;
    for (const [tool, command, verdict] of rows) {
      calls.parsed.length = 0;
      calls.cmdLines.length = 0;
      const result = worktreeIsolationBlock(tool, { command }, iso);
      if (verdict === undefined) expect(result, command).toBeUndefined();
      else expect(result, command).toContain(verdict);
      expect(calls.parsed.length).toBeGreaterThan(0);
      expect(new Set(calls.parsed).size, command).toBe(calls.parsed.length);
      expect(new Set(calls.cmdLines).size, command).toBe(calls.cmdLines.length);
    }
  });

  // A text scan whose inner run restarts at every `${` or `[` takes time quadratic in such a run's length.
  it('blocks or allows a long unclosed expansion or subscript run without running long', () => {
    const rows = [
      ['x=${'.repeat(5000), 'longer than'],
      ['a['.repeat(10_000), 'longer than'],
      [`echo ${'a['.repeat(4000)}`, undefined],
      [`echo ${'${a:-'.repeat(1300)}${'}'.repeat(1300)}`, undefined],
      [`echo ${'a'.repeat(8000)}`, undefined],
    ] as const;
    for (const [command, verdict] of rows) {
      const started = performance.now();
      const result = worktreeIsolationBlock('Bash', { command }, iso);
      if (verdict === undefined) expect(result).toBeUndefined();
      else expect(result).toContain(verdict);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it('reads the starting environment once per check, however many statements and children read it', () => {
    let listed = 0;
    let read = 0;
    const variables = Object.fromEntries(Array.from({ length: 500 }, (_, k) => [`VAR_${k}`, `value${k}`]));
    const environment = new Proxy(variables, {
      ownKeys: (target) => (listed++, Reflect.ownKeys(target)),
      get: (target, key) => (read++, Reflect.get(target, key)),
    });
    const bash = Array.from({ length: 100 }, (_, k) => `echo "$VAR_${k}"; export V${k}=x; bash -c 'echo "$VAR_${k + 1}"'`).join('\n');
    const ps = Array.from({ length: 100 }, (_, k) => `Write-Output $env:VAR_${k}; pwsh -NoProfile -Command 'Write-Output $env:VAR_${k + 1}'`).join('\n');
    for (const [tool, command] of [['Bash', bash], ['PowerShell', ps]] as const) {
      listed = 0;
      read = 0;
      expect(worktreeIsolationBlock(tool, { command }, { ...iso, environment })).toBeUndefined();
      expect(listed).toBe(1);
      expect(read).toBeLessThanOrEqual(500);
    }
  });
});
