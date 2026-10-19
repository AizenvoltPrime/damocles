import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dispatchToolCall,
  dispatchToolResult,
  dispatchInput,
  dispatchObserveOnly,
  type DispatchDeps,
  type ToolCallHookResult,
} from '../dispatch';
import type { HookEntry } from '../types';
import type { HooksConfigService } from '../config';
import type { HookCommon } from '../payload';

const common: HookCommon = { session_id: 's', transcript_path: '/t.jsonl', cwd: process.cwd() };

function nodeEntry(script: string, extra: Partial<HookEntry> = {}): HookEntry {
  return { command: [process.execPath, '-e', script], ...extra };
}

function mkDeps(entriesByKey: Record<string, HookEntry[]>): DispatchDeps {
  const config = {
    getEntries: (k: string) => entriesByKey[k] ?? [],
    hasEntries: (k: string) => (entriesByKey[k] ?? []).length > 0,
  } as unknown as HooksConfigService;
  return { config, workspaceRoot: process.cwd(), userHome: os.homedir() };
}

/** `dispatchToolCall` without a signal, which can never report an aborted chain. */
async function reconcile(deps: DispatchDeps, params: Parameters<typeof dispatchToolCall>[1]): Promise<ToolCallHookResult | null> {
  const r = await dispatchToolCall(deps, params);
  if (r && 'aborted' in r) throw new Error('a chain with no signal reported an abort');
  return r;
}

const allow = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow"}))');
const deny = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny",reason:"no"}))');
const denyTerminate = nodeEntry(
  'process.stdout.write(JSON.stringify({decision:"deny",reason:"stop",terminate:true}))',
);

describe('dispatchToolCall', () => {
  it('returns null when no hook matches (FR-14 zero-cost path)', async () => {
    const r = await reconcile(mkDeps({}), { common, toolName: 'Bash', toolInput: {} });
    expect(r).toBeNull();
  });

  it('deny beats allow (precedence deny > allow > ask)', async () => {
    const r = await reconcile(mkDeps({ tool_call: [allow, deny] }), {
      common,
      toolName: 'Bash',
      toolInput: { command: 'x' },
    });
    expect(r?.decision).toBe('deny');
    expect(r?.reason).toBe('no');
  });

  it('a deny without terminate leaves terminate absent (existing hooks are unchanged)', async () => {
    const r = await reconcile(mkDeps({ tool_call: [deny] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r?.decision).toBe('deny');
    expect(r).not.toHaveProperty('terminate');
  });

  it('a deny that opts into terminate sets terminate', async () => {
    const r = await reconcile(mkDeps({ tool_call: [denyTerminate] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.decision).toBe('deny');
    expect(r?.terminate).toBe(true);
  });

  it('one terminating deny among several hooks wins (most-restrictive, not unanimity)', async () => {
    const r = await reconcile(mkDeps({ tool_call: [deny, denyTerminate] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.decision).toBe('deny');
    expect(r?.terminate).toBe(true);
  });

  /**
   * A hook that timed out or failed to spawn produced no verdict at all, so it cannot have asked for a
   * terminate — its stdout is discarded whole. This is the fail-closed property the design claims: an
   * unhealthy hook loses its voice rather than keeping half of it.
   */
  it('a FAILED hook cannot contribute terminate even though its stdout asked for one', async () => {
    const printsThenHangs = nodeEntry(
      'process.stdout.write(JSON.stringify({decision:"deny",reason:"stop",terminate:true}));setTimeout(()=>{},10000)',
      { timeoutMs: 200 },
    );
    const r = await reconcile(mkDeps({ tool_call: [printsThenHangs, deny] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.anyFailed).toBe(true);
    expect(r?.decision).toBe('deny');
    expect(r).not.toHaveProperty('terminate');
  });

  it('ignores terminate on an allow verdict (pi honors it only on a blocked call)', async () => {
    const allowTerminate = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow",terminate:true}))');
    const r = await reconcile(mkDeps({ tool_call: [allowTerminate] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.decision).toBe('allow');
    expect(r).not.toHaveProperty('terminate');
  });

  it('allow wins when no deny present', async () => {
    const r = await reconcile(mkDeps({ tool_call: [allow] }), { common, toolName: 'Write', toolInput: {} });
    expect(r?.decision).toBe('allow');
  });

  it('chains updated_input so later hooks see earlier mutations', async () => {
    const setA = nodeEntry('process.stdout.write(JSON.stringify({updated_input:{file_path:"/a"}}))');
    const checkA = nodeEntry(
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({updated_input:{seen:j.input.file_path==="/a"}}))})',
    );
    const r = await reconcile(mkDeps({ tool_call: [setA, checkA] }), {
      common,
      toolName: 'Read',
      toolInput: { file_path: '/orig' },
    });
    expect(r?.mutated).toBe(true);
    expect(r?.finalInput).toMatchObject({ file_path: '/a', seen: true });
  });

  it('respects the match filter on the tool name', async () => {
    const denyBash = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny"}))', { match: 'Bash' });
    const r = await reconcile(mkDeps({ tool_call: [denyBash] }), { common, toolName: 'Read', toolInput: {} });
    expect(r).toBeNull();
  });

  describe('an MCP resource call naming a server', () => {
    // Denies with the payload's tool name and server as the reason, so a test sees what the hook was sent.
    const echoDeny = (match: string): HookEntry => nodeEntry(
      'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({decision:"deny",reason:p.tool_name+" "+p.input.server}))})',
      { match },
    );

    it('runs a hook whose match names the server\'s tools, which can block it, with the real tool name in the payload', async () => {
      const r = await reconcile(mkDeps({ tool_call: [echoDeny('mcp__secret__.*')] }), {
        common,
        toolName: 'read_mcp_resource',
        toolInput: { server: 'secret', uri: 'secret://a' },
      });
      expect(r?.decision).toBe('deny');
      expect(r?.reason).toBe('read_mcp_resource secret');
    });

    it('matches the name every MCP tool of the server has, sanitized as tool names are', async () => {
      const r = await reconcile(mkDeps({ tool_call: [echoDeny('^mcp__my_srv__list_mcp_resources$')] }), {
        common,
        toolName: 'list_mcp_resources',
        toolInput: { server: 'my.srv' },
      });
      expect(r?.reason).toBe('list_mcp_resources my.srv');
    });

    it('leaves another server\'s calls, a call without a server, and other tools alone', async () => {
      const deps = mkDeps({ tool_call: [echoDeny('mcp__secret__.*')] });
      expect(await dispatchToolCall(deps, { common, toolName: 'read_mcp_resource', toolInput: { server: 'public', uri: 'x' } })).toBeNull();
      expect(await dispatchToolCall(deps, { common, toolName: 'list_mcp_resources', toolInput: {} })).toBeNull();
      expect(await dispatchToolCall(deps, { common, toolName: 'list_mcp_resources', toolInput: { server: '' } })).toBeNull();
      expect(await dispatchToolCall(deps, { common, toolName: 'Read', toolInput: { server: 'secret' } })).toBeNull();
    });

    it('runs a hook matching the tool\'s own name for every server', async () => {
      const deps = mkDeps({ tool_call: [echoDeny('^read_mcp_resource$')] });
      for (const server of ['secret', 'public']) {
        const r = await reconcile(deps, { common, toolName: 'read_mcp_resource', toolInput: { server, uri: 'x' } });
        expect(r?.reason).toBe(`read_mcp_resource ${server}`);
      }
    });
  });

  it('collects each hook system_message for the caller to surface', async () => {
    const sys = nodeEntry('process.stdout.write(JSON.stringify({system_message:"note",decision:"allow"}))');
    const r = await reconcile(mkDeps({ tool_call: [sys] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r?.systemMessages).toEqual(['note']);
  });

  it('skips an entry whose match regex fails to compile (never matches)', async () => {
    const badMatch = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny"}))', { match: '(unclosed' });
    const r = await reconcile(mkDeps({ tool_call: [badMatch] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r).toBeNull();
  });

  it('an abort kills the running hook and its children, runs no later hook, and reports the chain aborted with only the earlier hooks\' notices', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-abort-pretool-'));
    try {
      const pids = path.join(dir, 'pids');
      const later = path.join(dir, 'later');
      const rewrite = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow",updated_input:{command:"rewritten"},context:"ctx",system_message:"note"}))');
      const holding = nodeEntry(
        `const { spawn } = require('child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid); setTimeout(() => {}, 30000);`,
      );
      const second = nodeEntry(`require('fs').writeFileSync(${JSON.stringify(later)}, 'ran')`);
      const controller = new AbortController();
      const judging = dispatchToolCall(mkDeps({ tool_call: [rewrite, holding, second] }), { common, toolName: 'Bash', toolInput: { command: 'x' } }, controller.signal);
      await vi.waitFor(() => expect(fs.readFileSync(pids, 'utf8')).toMatch(/^\d+ \d+$/), { timeout: 10_000 });
      const [parent, child] = fs.readFileSync(pids, 'utf8').split(' ').map(Number);

      const started = Date.now();
      controller.abort();
      expect(await judging).toEqual({ aborted: true, systemMessages: ['note'] });
      expect(Date.now() - started).toBeLessThan(1_000);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });
      expect(fs.existsSync(later)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs no hook when the signal is already aborted, and reports the chain aborted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-abort-pretool-'));
    try {
      const ran = path.join(dir, 'ran');
      const controller = new AbortController();
      controller.abort();
      const r = await dispatchToolCall(mkDeps({ tool_call: [nodeEntry(`require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran')`)] }), { common, toolName: 'Bash', toolInput: {} }, controller.signal);
      expect(r).toEqual({ aborted: true, systemMessages: [] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fs.existsSync(ran)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dispatchToolResult', () => {
  it('blocks and replaces the output', async () => {
    const post = nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"bad",updated_output:"clean"}))');
    const r = await dispatchToolResult(mkDeps({ tool_result: [post] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
      toolResponse: 'x',
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toBe('bad');
    expect(r?.updatedToolOutput).toBe('clean');
  });

  it('chains updated_output so a later hook sees the earlier replacement (not the original)', async () => {
    const first = nodeEntry('process.stdout.write(JSON.stringify({updated_output:"STEP1"}))');
    const second = nodeEntry(
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({updated_output:j.result.output==="STEP1"?"STEP1+STEP2":"NOT-CHAINED"}))})',
    );
    const r = await dispatchToolResult(mkDeps({ tool_result: [first, second] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
      toolResponse: { output: 'orig', is_error: false },
    });
    expect(r?.updatedToolOutput).toBe('STEP1+STEP2');
  });

  it('runs a hook whose match names the server of an MCP resource call, with the real tool name in the payload', async () => {
    const post = nodeEntry(
      'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({decision:"block",reason:p.tool_name+" "+p.input.server}))})',
      { match: 'mcp__secret__.*' },
    );
    const deps = mkDeps({ tool_result: [post] });
    const r = await dispatchToolResult(deps, { common, toolName: 'read_mcp_resource', toolInput: { server: 'secret', uri: 'secret://a' }, toolResponse: 'x' });
    expect(r?.block).toBe(true);
    expect(r?.reason).toBe('read_mcp_resource secret');
    expect(await dispatchToolResult(deps, { common, toolName: 'read_mcp_resource', toolInput: { server: 'public', uri: 'x' }, toolResponse: 'x' })).toBeNull();
  });
});

describe('dispatchInput', () => {
  it('surfaces context + session_title', async () => {
    const inp = nodeEntry('process.stdout.write(JSON.stringify({context:"ctx",session_title:"My Title"}))');
    const r = await dispatchInput(mkDeps({ input: [inp] }), { common, prompt: 'hi' });
    expect(r?.additionalContext).toBe('ctx');
    expect(r?.sessionTitle).toBe('My Title');
    expect(r?.block).toBe(false);
  });

  it('blocks on a decision:block response', async () => {
    const inp = nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"blocked"}))');
    const r = await dispatchInput(mkDeps({ input: [inp] }), { common, prompt: 'hi' });
    expect(r?.block).toBe(true);
    expect(r?.reason).toBe('blocked');
  });

  it('an abort kills the running hook and its children, settles at once, and runs no later hook', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-abort-hook-'));
    try {
      const pids = path.join(dir, 'pids');
      const later = path.join(dir, 'later');
      // The hook starts a child of its own, as a shell-string hook does, so the kill has to reach the tree.
      const holding = nodeEntry(
        `const { spawn } = require('child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid); setTimeout(() => {}, 30000);`,
      );
      const second = nodeEntry(`require('fs').writeFileSync(${JSON.stringify(later)}, 'ran')`);
      const controller = new AbortController();
      const judging = dispatchInput(mkDeps({ input: [holding, second] }), { common, prompt: 'hi' }, controller.signal);
      await vi.waitFor(() => expect(fs.existsSync(pids)).toBe(true), { timeout: 10_000 });
      const [parent, child] = fs.readFileSync(pids, 'utf8').split(' ').map(Number);

      const started = Date.now();
      controller.abort();
      expect(await judging).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });
      expect(fs.existsSync(later)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs no hook when the signal is already aborted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-abort-hook-'));
    try {
      const ran = path.join(dir, 'ran');
      const controller = new AbortController();
      controller.abort();
      const r = await dispatchInput(mkDeps({ input: [nodeEntry(`require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran')`)] }), { common, prompt: 'hi' }, controller.signal);
      expect(r).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fs.existsSync(ran)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dispatchObserveOnly', () => {
  it('runs every entry and returns the count', async () => {
    const n = await dispatchObserveOnly(mkDeps({ permission_required: [nodeEntry('')] }), 'permission_required', common.cwd, {
      event: 'permission_required',
    });
    expect(n).toBe(1);
  });

  it('is a no-op when no entry is configured', async () => {
    const n = await dispatchObserveOnly(mkDeps({}), 'turn_end', common.cwd, {});
    expect(n).toBe(0);
  });
});
