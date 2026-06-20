import { describe, it, expect } from 'vitest';
import * as os from 'os';
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
