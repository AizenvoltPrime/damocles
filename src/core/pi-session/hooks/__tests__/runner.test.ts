import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../../__mocks__/spawn-budget';
import { parseHookOutput, runHook, type RunHookContext } from '../runner';
import type { HookEntry } from '../types';

const ctx: RunHookContext = {
  cwd: process.cwd(),
  env: process.env,
  substitution: { workspaceFolder: process.cwd(), userHome: os.homedir(), env: process.env },
  eventKey: 'tool_call',
};

/** A hook entry that runs a node one-liner via argv (no shell, cross-platform). */
function nodeEntry(script: string, timeoutMs?: number): HookEntry {
  return { command: [process.execPath, '-e', script], ...(timeoutMs ? { timeoutMs } : {}) };
}

describe('parseHookOutput', () => {
  it('exit 0 + empty stdout → no-op', () => {
    const d = parseHookOutput(0, '', '');
    expect(d.block).toBe(false);
    expect(d.permissionDecision).toBeUndefined();
    expect(d.additionalContext).toBeUndefined();
  });

  it('any non-zero exit → fail-soft no-op (exit code is health, not a signal)', () => {
    const d = parseHookOutput(2, '', 'too dangerous');
    expect(d.block).toBe(false);
    expect(d.failed).toBe(false);
    const d3 = parseHookOutput(3, '', 'boom');
    expect(d3.block).toBe(false);
    expect(d3.failed).toBe(false);
  });

  it('JSON decision allow', () => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'allow' }), '');
    expect(d.permissionDecision).toBe('allow');
    expect(d.block).toBe(false);
  });

  it('JSON decision deny sets block + reason', () => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'deny', reason: 'no' }), '');
    expect(d.permissionDecision).toBe('deny');
    expect(d.block).toBe(true);
    expect(d.reason).toBe('no');
  });

  it('JSON deny without terminate leaves terminate absent (the default is unchanged)', () => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'deny', reason: 'no' }), '');
    expect(d).not.toHaveProperty('terminate');
  });

  it('JSON deny + terminate:true sets terminate', () => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'deny', reason: 'no', terminate: true }), '');
    expect(d.block).toBe(true);
    expect(d.terminate).toBe(true);
  });

  /**
   * Untrusted hook stdout becomes a turn-ending flag here and nowhere else, so the strict `=== true`
   * check is pinned: a shell/jq one-liner emitting `"true"` or `1` is the likeliest way a hook author
   * ends up asking for something they did not mean. Relaxing this to `Boolean(...)` would also let
   * `"false"`, `{}` and `[]` through.
   */
  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['an empty object', {}],
    ['an empty array', []],
  ])('JSON deny + terminate as %s is IGNORED (only the boolean true terminates)', (_label, value) => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'deny', reason: 'no', terminate: value }), '');
    expect(d.block).toBe(true);
    expect(d).not.toHaveProperty('terminate');
  });

  it('JSON updated_input', () => {
    const d = parseHookOutput(0, JSON.stringify({ updated_input: { file_path: '/x' } }), '');
    expect(d.updatedInput).toEqual({ file_path: '/x' });
  });

  it('JSON decision:block + reason', () => {
    const d = parseHookOutput(0, JSON.stringify({ decision: 'block', reason: 'stop' }), '');
    expect(d.block).toBe(true);
    expect(d.reason).toBe('stop');
  });

  it('JSON context / updated_output / session_title / system_message', () => {
    const d = parseHookOutput(
      0,
      JSON.stringify({ context: 'ctx', updated_output: 'clean', session_title: ' Title ', system_message: 'fyi' }),
      '',
    );
    expect(d.additionalContext).toBe('ctx');
    expect(d.updatedToolOutput).toBe('clean');
    expect(d.sessionTitle).toBe('Title');
    expect(d.systemMessage).toBe('fyi');
  });

  it('plain (non-JSON) stdout → context', () => {
    const d = parseHookOutput(0, 'extra context here', '');
    expect(d.additionalContext).toBe('extra context here');
  });
});

describe('runHook (real spawn)', () => {
  it('exit 0 empty → no-op', async () => {
    const d = await runHook(nodeEntry(''), {}, ctx);
    expect(d.block).toBe(false);
    expect(d.failed).toBe(false);
  });

  it('exit 2 is now a fail-soft no-op (no exit-code blocking)', async () => {
    const d = await runHook(nodeEntry('process.stderr.write("nope");process.exit(2)'), {}, ctx);
    expect(d.block).toBe(false);
    expect(d.failed).toBe(false);
  });

  it('JSON deny', async () => {
    const script = 'process.stdout.write(JSON.stringify({decision:"deny",reason:"nope"}))';
    const d = await runHook(nodeEntry(script), {}, ctx);
    expect(d.permissionDecision).toBe('deny');
    expect(d.reason).toBe('nope');
  });

  it('JSON allow + updated_input', async () => {
    const script = 'process.stdout.write(JSON.stringify({decision:"allow",updated_input:{file_path:"/new"}}))';
    const d = await runHook(nodeEntry(script), {}, ctx);
    expect(d.permissionDecision).toBe('allow');
    expect(d.updatedInput).toEqual({ file_path: '/new' });
  });

  it('plain stdout → context', async () => {
    const d = await runHook(nodeEntry('process.stdout.write("hello ctx")'), {}, ctx);
    expect(d.additionalContext).toBe('hello ctx');
  });

  it('keeps a trailing partial UTF-8 character as U+FFFD rather than dropping it', async () => {
    const d = await runHook(nodeEntry('process.stdout.write(Buffer.from([0x6f, 0x6b, 0xc3]))'), {}, ctx);
    expect(d.additionalContext).toBe('ok\uFFFD');
  });

  it('the native payload is delivered on stdin', async () => {
    const script = [
      'let d="";process.stdin.on("data",c=>d+=c);',
      'process.stdin.on("end",()=>{const j=JSON.parse(d);',
      'process.stdout.write(JSON.stringify({decision:j.tool_name==="Bash"?"deny":"allow"}))})',
    ].join('');
    const d = await runHook(nodeEntry(script), { tool_name: 'Bash', input: { command: 'ls' } }, ctx);
    expect(d.permissionDecision).toBe('deny');
  });

  it('timeout → fail-soft failed', async () => {
    const d = await runHook(nodeEntry('setTimeout(()=>{},10000)', 200), {}, ctx);
    expect(d.failed).toBe(true);
    expect(d.block).toBe(false);
  });

  it('a timeout kills the hook and the process it started', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-hook-timeout-'));
    try {
      const pids = path.join(dir, 'pids');
      const holding = nodeEntry(
        `const { spawn } = require('child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid); setTimeout(() => {}, 30000);`,
        SPAWN_TEST_TIMEOUT_MS / 3,
      );

      const d = await runHook(holding, {}, ctx);

      expect(d.failed).toBe(true);
      const [parent, grandchild] = fs.readFileSync(pids, 'utf8').split(' ').map(Number);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect([alive(parent!), alive(grandchild!)]).toEqual([false, false]), { timeout: SPAWN_TEST_TIMEOUT_MS });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, SPAWN_TEST_TIMEOUT_MS * 2);

  it('a timeout kills what a hook left holding its output after the hook itself exited', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-hook-exited-'));
    try {
      const pids = path.join(dir, 'pids');
      // Detached on Windows only: libuv's own job would kill it there with its parent, and on POSIX it must stay in the hook's group.
      const leaving = nodeEntry(
        `const { spawn } = require('child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32' }); child.unref(); require('fs').writeFileSync(${JSON.stringify(pids)}, String(child.pid));`,
        SPAWN_TEST_TIMEOUT_MS / 3,
      );

      const d = await runHook(leaving, {}, ctx);

      expect(d.failed).toBe(true);
      const left = Number(fs.readFileSync(pids, 'utf8'));
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect(alive(left)).toBe(false), { timeout: SPAWN_TEST_TIMEOUT_MS });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, SPAWN_TEST_TIMEOUT_MS * 2);

  it('a non-serializable payload → fail-soft failed, no orphaned child (M2)', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const d = await runHook(nodeEntry('process.stdout.write("should not run")'), circular, ctx);
    expect(d.failed).toBe(true);
    expect(d.block).toBe(false);
    expect(d.additionalContext).toBeUndefined();
  });

  it('other non-zero → fail-soft, not failed', async () => {
    const d = await runHook(nodeEntry('process.exit(3)'), {}, ctx);
    expect(d.block).toBe(false);
    expect(d.failed).toBe(false);
  });

  it('shell-string command runs via the shell', async () => {
    const d = await runHook({ command: 'echo shellpath' }, {}, ctx);
    expect(d.additionalContext).toBe('shellpath');
  });
});
