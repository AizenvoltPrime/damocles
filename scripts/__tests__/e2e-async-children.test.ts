import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { killTree, run, windowsProcessTree } from '../../e2e/desktop/support/app';

// A worker that holds the foreground or clipboard lock refreshes it on its event loop (e2e/desktop/support/fair-lock.ts), so
// a synchronous child process in code a worker runs stalls the refresh and lets another worker take the lock over.
const ROOT = join(__dirname, '..', '..');
const SYNC_CHILD_CALLS = new Set(['spawnSync', 'execFileSync', 'execSync']);

// Files under e2e/desktop that never run on a worker's event loop.
const OWN_PROCESS: Record<string, string> = {
  'e2e/desktop/global-setup.ts': "Playwright's runner process, before any worker starts",
  'e2e/desktop/update/': 'the update driver, a Node process of its own',
  'e2e/desktop/second-process/': 'the second host, which support/second-process.ts forks',
  'e2e/desktop/fixtures/': 'stand-ins the app under test loads',
  'e2e/desktop/support/hold-chat-pages.cjs': 'the Electron main process, through LaunchOptions.require',
  'e2e/desktop/support/mcp-stdio-server.cjs': 'an MCP server process the app spawns',
};

function syncChildCalls(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    // A string literal catches element access, such as cp['execSync'].
    const named = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (named && SYNC_CHILD_CALLS.has(node.text)) findings.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function idleNode(options: { detached?: boolean } = {}): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, ...options });
}

/** Runs `body` with a `powershell` on PATH that is Node, which rejects PowerShell's options and exits 9. */
async function withFailingPowerShell<T>(body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-powershell-'));
  const savedPath = process.env.PATH;
  copyFileSync(process.execPath, join(dir, 'powershell.exe'));
  // System32 keeps taskkill reachable; Windows PowerShell lives in a folder below it, which is left off.
  process.env.PATH = `${dir};${join(process.env.SystemRoot!, 'System32')}`;
  try {
    return await body();
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('e2e child processes', () => {
  it('never run synchronously in code a Playwright worker runs', () => {
    const files = globSync('e2e/desktop/**/*.{ts,cjs,mjs,js}', { cwd: ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => !Object.keys(OWN_PROCESS).some((excluded) => file.startsWith(excluded)));
    expect(files.filter((file) => file.startsWith('e2e/desktop/support/')).length).toBeGreaterThan(10);
    expect(files.filter((file) => file.endsWith('.spec.ts')).length).toBeGreaterThan(10);
    expect(files.flatMap((file) => syncChildCalls(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
  });

  it('flags each synchronous form (guards the scan itself)', () => {
    const samples = [
      "import { spawnSync } from 'node:child_process';",
      "cp.execFileSync('sample', []);",
      'execSync("ls")',
      "cp['execSync']('ls');",
      "require('node:child_process')['spawnSync']('ls');",
      'cp[`execFileSync`]("ls", []);',
    ];
    for (const sample of samples) expect(syncChildCalls('sample.ts', sample), sample).not.toEqual([]);
  });
});

describe('run', () => {
  it('rejects once the child outlives its bound, and kills it', async () => {
    await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 500)).rejects.toThrow(/did not finish within 500 ms/);
  }, 10_000);

  it('gives the child no stdin to wait on', async () => {
    expect((await run(process.execPath, ['-e', "process.stdin.on('end', () => process.stdout.write('stdin closed')).resume()"])).stdout).toBe('stdin closed');
  }, 10_000);

  it('decodes a character whose bytes arrive in separate chunks', async () => {
    const script = 'process.stdout.write(Buffer.from([0xce])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 200);';
    expect((await run(process.execPath, ['-e', script])).stdout).toBe('Ω');
  }, 10_000);
});

describe.runIf(process.platform === 'win32')('the Windows process tree', () => {
  it("reads the table's parent links while the event loop keeps running", async () => {
    const child = idleNode();
    try {
      let ticks = 0;
      const interval = setInterval(() => ticks++, 10);
      const tree = await windowsProcessTree(process.pid).finally(() => clearInterval(interval));
      expect(tree[0]).toBe(process.pid);
      expect(tree).toContain(child.pid);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('rejects with the reader\'s stderr when the table read fails', async () => {
    await withFailingPowerShell(() => expect(windowsProcessTree(process.pid)).rejects.toThrow(/exited with code 9: .*bad option: -NoProfile/));
  }, 30_000);

  it('still kills the tree when the table read fails, then rejects', async () => {
    const child = idleNode();
    try {
      await withFailingPowerShell(() => expect(killTree(child)).rejects.toThrow(/bad option: -NoProfile/));
      expect(isAlive(child.pid!)).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('kills the descendants it read when the root exits before taskkill runs', async () => {
    const script = "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); g.unref(); process.stdout.write(String(g.pid));";
    const root = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    root.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
    await new Promise((resolve) => root.once('close', resolve));
    const grandchild = Number(out);
    try {
      expect(isAlive(grandchild)).toBe(true);
      // The root as killTree sees it in the window between its exit and Node noticing.
      await killTree({ pid: root.pid, exitCode: null, signalCode: null });
      expect(isAlive(grandchild)).toBe(false);
    } finally {
      if (isAlive(grandchild)) process.kill(grandchild);
    }
  }, 30_000);
});
