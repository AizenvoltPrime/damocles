import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { registerConfiguredHooks, HOOK_CONTEXT_CUSTOM_TYPE, type ConfiguredHooksDeps } from '../index';
import { createPreToolUseContextStash, stashPreToolUseContext, type PreToolUseContextStash } from '../context-stash';
import type { HookEntry } from '../types';
import type { HooksConfigService } from '../config';

function nodeEntry(script: string, extra: Partial<HookEntry> = {}): HookEntry {
  return { command: [process.execPath, '-e', script], ...extra };
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi(): { pi: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
  return { pi, handlers };
}

function fakeCtx(sessionId = 's1'): unknown {
  return {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/t.jsonl' },
  };
}

function mkDeps(
  entriesByKey: Record<string, HookEntry[]>,
  opts: { noPanel?: boolean; preToolUseContextStash?: PreToolUseContextStash } = {},
): { deps: ConfiguredHooksDeps; postMessage: ReturnType<typeof vi.fn>; renameSession: ReturnType<typeof vi.fn> } {
  const config = {
    getEntries: (k: string) => entriesByKey[k] ?? [],
    hasEntries: (k: string) => (entriesByKey[k] ?? []).length > 0,
  } as unknown as HooksConfigService;
  const postMessage = vi.fn();
  const renameSession = vi.fn(async () => {});
  const registry = { get: () => (opts.noPanel ? undefined : { postMessage }) };
  return {
    deps: {
      dispatch: { config, workspaceRoot: process.cwd(), userHome: os.homedir() },
      registry,
      renameSession,
      ...(opts.preToolUseContextStash ? { preToolUseContextStash: opts.preToolUseContextStash } : {}),
    },
    postMessage,
    renameSession,
  };
}

describe('registerConfiguredHooks — UserPromptSubmit', () => {
  it('blocks the prompt on a decision:block response and surfaces a notification', async () => {
    const { pi, handlers } = fakePi();
    const { deps, postMessage } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"blocked!"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    const result = await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx());
    expect(result).toEqual({ action: 'handled' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'blocked!' }));
  });

  it('stashes additionalContext and drains it at before_agent_start as a hidden message', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({ input: [nodeEntry('process.stdout.write("inject me")')] });
    registerConfiguredHooks(pi as never, deps);
    const cont = await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx());
    expect(cont).toBeUndefined();
    const drained = (await handlers.get('before_agent_start')!({}, fakeCtx())) as { message?: { content: string; customType: string; display: boolean } };
    expect(drained?.message?.content).toBe('inject me');
    expect(drained?.message?.customType).toBe(HOOK_CONTEXT_CUSTOM_TYPE);
    expect(drained?.message?.display).toBe(false);
    // The stash is cleared after draining.
    expect(await handlers.get('before_agent_start')!({}, fakeCtx())).toBeUndefined();
  });

  it('runs configured before_agent_start hooks and injects their stdout as context', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({ before_agent_start: [nodeEntry('process.stdout.write("from before_agent_start")')] });
    registerConfiguredHooks(pi as never, deps);
    const result = (await handlers.get('before_agent_start')!({ prompt: 'hi' }, fakeCtx())) as {
      message?: { content: string };
    };
    expect(result?.message?.content).toBe('from before_agent_start');
  });

  it('merges before_agent_start hook context with the drained UserPromptSubmit stash', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({
      input: [nodeEntry('process.stdout.write("from input")')],
      before_agent_start: [nodeEntry('process.stdout.write("from bas")')],
    });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx());
    const result = (await handlers.get('before_agent_start')!({ prompt: 'hi' }, fakeCtx())) as {
      message?: { content: string };
    };
    expect(result?.message?.content).toContain('from bas');
    expect(result?.message?.content).toContain('from input');
  });

  it('renames the session on sessionTitle', async () => {
    const { pi, handlers } = fakePi();
    const { deps, renameSession } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({session_title:"Renamed"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx());
    expect(renameSession).toHaveBeenCalledWith('s1', process.cwd(), 'Renamed');
  });

  it('surfaces a UserPromptSubmit systemMessage as a notification', async () => {
    const { pi, handlers } = fakePi();
    const { deps, postMessage } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({system_message:"prompt note"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'prompt note' }));
  });

  it('ignores non-interactive input', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({ input: [nodeEntry('process.exit(2)')] });
    registerConfiguredHooks(pi as never, deps);
    expect(await handlers.get('input')!({ source: 'rpc', text: 'hi' }, fakeCtx())).toBeUndefined();
  });
});

describe('registerConfiguredHooks — PostToolUse', () => {
  const resultEvent = (over: Record<string, unknown> = {}) => ({
    toolCallId: 'c1',
    toolName: 'bash',
    input: { command: 'ls' },
    content: [{ type: 'text', text: 'out' }],
    isError: false,
    details: undefined,
    ...over,
  });

  it('blocks the result (isError + appended reason)', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({ tool_result: [nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"unsafe"}))')] });
    registerConfiguredHooks(pi as never, deps);
    const patch = (await handlers.get('tool_result')!(resultEvent(), fakeCtx())) as { isError?: boolean; content?: { text: string }[] };
    expect(patch?.isError).toBe(true);
    expect(patch?.content?.[0].text).toContain('unsafe');
  });

  it('appends stashed PreToolUse additionalContext to the result and drains the stash (H1 delivery)', async () => {
    const { pi, handlers } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'c1', 'from pre-hook');
    const { deps } = mkDeps({}, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    const patch = (await handlers.get('tool_result')!(resultEvent(), fakeCtx())) as { content?: { text: string }[] };
    expect(patch?.content?.[0].text).toContain('out');
    expect(patch?.content?.[0].text).toContain('from pre-hook');
    expect(stash.has('c1')).toBe(false);
  });

  it('drains the stash even when no panel is registered, so a session rebind cannot leak it (M1)', async () => {
    const { pi, handlers } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'c1', 'orphan');
    const { deps } = mkDeps({}, { noPanel: true, preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    expect(await handlers.get('tool_result')!(resultEvent(), fakeCtx())).toBeUndefined();
    expect(stash.has('c1')).toBe(false);
  });

  it('sweeps this session\'s orphaned stash entries at agent_end, leaving other sessions untouched (H1)', async () => {
    const { pi, handlers } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'orphan-s1', 'never resulted');
    stashPreToolUseContext(stash, 's2', 'pending-s2', 'other session');
    const { deps } = mkDeps({}, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('agent_end')!({ messages: [] }, fakeCtx('s1'));
    expect(stash.has('orphan-s1')).toBe(false);
    expect(stash.has('pending-s2')).toBe(true);
  });

  it('sweeps this session\'s orphaned stash entries at session_shutdown, even with no panel (L1)', async () => {
    const { pi, handlers } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'orphan-s1', 'panel closed mid-turn');
    stashPreToolUseContext(stash, 's2', 'pending-s2', 'other session');
    const { deps } = mkDeps({}, { noPanel: true, preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('session_shutdown')!({ reason: 'closed' }, fakeCtx('s1'));
    expect(stash.has('orphan-s1')).toBe(false);
    expect(stash.has('pending-s2')).toBe(true);
  });

  it('is a no-op when no tool_result hook and no stashed context (FR-14 zero cost — L1)', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    expect(await handlers.get('tool_result')!(resultEvent(), fakeCtx())).toBeUndefined();
  });

  it('surfaces a PostToolUse systemMessage as a notification', async () => {
    const { pi, handlers } = fakePi();
    const { deps, postMessage } = mkDeps({ tool_result: [nodeEntry('process.stdout.write(JSON.stringify({system_message:"fyi"}))')] });
    registerConfiguredHooks(pi as never, deps);
    await handlers.get('tool_result')!(resultEvent(), fakeCtx());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'fyi' }));
  });
});

describe('registerConfiguredHooks — Tier-2 + exclusions (US-007)', () => {
  it('registers Tier-2 events but never the excluded high-frequency ones', () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    for (const ev of ['model_select', 'turn_end', 'message_start', 'resources_discover']) {
      expect(handlers.has(ev)).toBe(true);
    }
    for (const ev of ['message_update', 'tool_execution_start', 'tool_execution_end', 'context', 'before_provider_request', 'user_bash', 'project_trust']) {
      expect(handlers.has(ev)).toBe(false);
    }
  });

  it('registers both compaction handlers (pre + post)', () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    expect(handlers.has('session_before_compact')).toBe(true);
    expect(handlers.has('session_compact')).toBe(true);
  });

  // A hook that dumps its stdin to a temp file, so the test can assert the exact payload the handler
  // forwarded from the pi event (locks in the event.reason / event.willRetry / event.fromExtension reads).
  function captureEntry(outFile: string): HookEntry {
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(
      outFile,
    )},d))`;
    return nodeEntry(script);
  }

  it('session_before_compact forwards reason + will_retry to the hook stdin', async () => {
    const { pi, handlers } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-precompact-${process.pid}-${Date.now()}.json`);
    const { deps } = mkDeps({ session_before_compact: [captureEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      await handlers.get('session_before_compact')!({ reason: 'manual', willRetry: false }, fakeCtx());
      const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(payload).toMatchObject({ event: 'session_before_compact', reason: 'manual', will_retry: false });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('session_compact forwards reason + will_retry + from_extension to the hook stdin', async () => {
    const { pi, handlers } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-compact-${process.pid}-${Date.now()}.json`);
    const { deps } = mkDeps({ session_compact: [captureEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      await handlers.get('session_compact')!({ reason: 'overflow', willRetry: true, fromExtension: true }, fakeCtx());
      const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(payload).toMatchObject({
        event: 'session_compact',
        reason: 'overflow',
        will_retry: true,
        from_extension: true,
      });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('a Tier-2 event is a no-op when unconfigured (FR-14)', async () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    await expect(handlers.get('turn_end')!({}, fakeCtx())).resolves.toBeUndefined();
  });
});

describe('registerConfiguredHooks — scope guard', () => {
  it('does nothing when no panel is registered for the session (internal sub-calls)', async () => {
    const { pi, handlers } = fakePi();
    const { deps, postMessage } = mkDeps({ input: [nodeEntry('process.exit(2)')] }, { noPanel: true });
    registerConfiguredHooks(pi as never, deps);
    expect(await handlers.get('input')!({ source: 'interactive', text: 'hi' }, fakeCtx())).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
