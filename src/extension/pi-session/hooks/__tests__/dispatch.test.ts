import { describe, it, expect } from 'vitest';
import * as os from 'os';
import {
  dispatchToolCall,
  dispatchToolResult,
  dispatchInput,
  dispatchObserveOnly,
  type DispatchDeps,
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

const allow = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow"}))');
const deny = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny",reason:"no"}))');
const denyTerminate = nodeEntry(
  'process.stdout.write(JSON.stringify({decision:"deny",reason:"stop",terminate:true}))',
);

describe('dispatchToolCall', () => {
  it('returns null when no hook matches (FR-14 zero-cost path)', async () => {
    const r = await dispatchToolCall(mkDeps({}), { common, toolName: 'Bash', toolInput: {} });
    expect(r).toBeNull();
  });

  it('deny beats allow (precedence deny > allow > ask)', async () => {
    const r = await dispatchToolCall(mkDeps({ tool_call: [allow, deny] }), {
      common,
      toolName: 'Bash',
      toolInput: { command: 'x' },
    });
    expect(r?.decision).toBe('deny');
    expect(r?.reason).toBe('no');
  });

  it('a deny without terminate leaves terminate absent (existing hooks are unchanged)', async () => {
    const r = await dispatchToolCall(mkDeps({ tool_call: [deny] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r?.decision).toBe('deny');
    expect(r).not.toHaveProperty('terminate');
  });

  it('a deny that opts into terminate sets terminate', async () => {
    const r = await dispatchToolCall(mkDeps({ tool_call: [denyTerminate] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.decision).toBe('deny');
    expect(r?.terminate).toBe(true);
  });

  it('one terminating deny among several hooks wins (most-restrictive, not unanimity)', async () => {
    const r = await dispatchToolCall(mkDeps({ tool_call: [deny, denyTerminate] }), {
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
    const r = await dispatchToolCall(mkDeps({ tool_call: [printsThenHangs, deny] }), {
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
    const r = await dispatchToolCall(mkDeps({ tool_call: [allowTerminate] }), {
      common,
      toolName: 'Bash',
      toolInput: {},
    });
    expect(r?.decision).toBe('allow');
    expect(r).not.toHaveProperty('terminate');
  });

  it('allow wins when no deny present', async () => {
    const r = await dispatchToolCall(mkDeps({ tool_call: [allow] }), { common, toolName: 'Write', toolInput: {} });
    expect(r?.decision).toBe('allow');
  });

  it('chains updated_input so later hooks see earlier mutations', async () => {
    const setA = nodeEntry('process.stdout.write(JSON.stringify({updated_input:{file_path:"/a"}}))');
    const checkA = nodeEntry(
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({updated_input:{seen:j.input.file_path==="/a"}}))})',
    );
    const r = await dispatchToolCall(mkDeps({ tool_call: [setA, checkA] }), {
      common,
      toolName: 'Read',
      toolInput: { file_path: '/orig' },
    });
    expect(r?.mutated).toBe(true);
    expect(r?.finalInput).toMatchObject({ file_path: '/a', seen: true });
  });

  it('respects the match filter on the tool name', async () => {
    const denyBash = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny"}))', { match: 'Bash' });
    const r = await dispatchToolCall(mkDeps({ tool_call: [denyBash] }), { common, toolName: 'Read', toolInput: {} });
    expect(r).toBeNull();
  });

  it('collects each hook system_message for the caller to surface', async () => {
    const sys = nodeEntry('process.stdout.write(JSON.stringify({system_message:"note",decision:"allow"}))');
    const r = await dispatchToolCall(mkDeps({ tool_call: [sys] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r?.systemMessages).toEqual(['note']);
  });

  it('skips an entry whose match regex fails to compile (never matches)', async () => {
    const badMatch = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny"}))', { match: '(unclosed' });
    const r = await dispatchToolCall(mkDeps({ tool_call: [badMatch] }), { common, toolName: 'Bash', toolInput: {} });
    expect(r).toBeNull();
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
