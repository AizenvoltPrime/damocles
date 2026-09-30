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

/** `on` hands back a real unsubscribe that drops the entry it just set, as pi's does. A no-op stub would
 *  make every retirement assertion in this file vacuous. Handlers are held per event in registration
 *  order, like pi's runner: a one-deep map would let an accidental second `pi.on` for the same event
 *  overwrite the first, which is invisible to every assertion here. */
function fakePi(): { pi: unknown; handlers: Map<string, Handler[]>; dispatch: Dispatch } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        const at = current.indexOf(handler);
        if (at !== -1) current.splice(at, 1);
        if (current.length === 0) handlers.delete(event);
      };
    },
  };
  return { pi, handlers, dispatch: (event, payload, ctx) => dispatchTo(handlers, event, payload, ctx) };
}

type Dispatch = (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;

/** Run every handler for one event in registration order and answer with the last defined result, as
 *  pi's runner does. Throws on an unregistered event, so a renamed event fails loudly instead of
 *  passing a test that no longer exercises anything. */
async function dispatchTo(
  handlers: Map<string, Handler[]>,
  event: string,
  payload: unknown,
  ctx: unknown,
): Promise<unknown> {
  const registered = handlers.get(event);
  if (!registered?.length) throw new Error(`no handler registered for ${event}`);
  let result: unknown;
  for (const handler of registered) {
    const value = await handler(payload, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}

function fakeCtx(sessionId = 's1', messages: unknown[] = []): unknown {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => '/t.jsonl',
      // `agent_settled` carries no messages, so the Stop dispatch reads the projection instead.
      buildSessionProjection: () => ({ messages }),
    },
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
    const { pi, dispatch } = fakePi();
    const { deps, postMessage } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"blocked!"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    const result = await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx());
    expect(result).toEqual({ action: 'handled' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'blocked!' }));
  });

  it('stashes additionalContext and drains it at before_agent_start as a hidden message', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({ input: [nodeEntry('process.stdout.write("inject me")')] });
    registerConfiguredHooks(pi as never, deps);
    const cont = await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx());
    expect(cont).toBeUndefined();
    const drained = (await dispatch('before_agent_start', {}, fakeCtx())) as { message?: { content: string; customType: string; display: boolean } };
    expect(drained?.message?.content).toBe('inject me');
    expect(drained?.message?.customType).toBe(HOOK_CONTEXT_CUSTOM_TYPE);
    expect(drained?.message?.display).toBe(false);
    // The stash is cleared after draining.
    expect(await dispatch('before_agent_start', {}, fakeCtx())).toBeUndefined();
  });

  it('runs configured before_agent_start hooks and injects their stdout as context', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({ before_agent_start: [nodeEntry('process.stdout.write("from before_agent_start")')] });
    registerConfiguredHooks(pi as never, deps);
    const result = (await dispatch('before_agent_start', { prompt: 'hi' }, fakeCtx())) as {
      message?: { content: string };
    };
    expect(result?.message?.content).toBe('from before_agent_start');
  });

  it('merges before_agent_start hook context with the drained UserPromptSubmit stash', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({
      input: [nodeEntry('process.stdout.write("from input")')],
      before_agent_start: [nodeEntry('process.stdout.write("from bas")')],
    });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx());
    const result = (await dispatch('before_agent_start', { prompt: 'hi' }, fakeCtx())) as {
      message?: { content: string };
    };
    expect(result?.message?.content).toContain('from bas');
    expect(result?.message?.content).toContain('from input');
  });

  it('renames the session on sessionTitle', async () => {
    const { pi, dispatch } = fakePi();
    const { deps, renameSession } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({session_title:"Renamed"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx());
    expect(renameSession).toHaveBeenCalledWith('s1', process.cwd(), 'Renamed');
  });

  it('surfaces a UserPromptSubmit systemMessage as a notification', async () => {
    const { pi, dispatch } = fakePi();
    const { deps, postMessage } = mkDeps({
      input: [nodeEntry('process.stdout.write(JSON.stringify({system_message:"prompt note"}))')],
    });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'prompt note' }));
  });

  it('ignores non-interactive input', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({ input: [nodeEntry('process.exit(2)')] });
    registerConfiguredHooks(pi as never, deps);
    expect(await dispatch('input', { source: 'rpc', text: 'hi' }, fakeCtx())).toBeUndefined();
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
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({ tool_result: [nodeEntry('process.stdout.write(JSON.stringify({decision:"block",reason:"unsafe"}))')] });
    registerConfiguredHooks(pi as never, deps);
    const patch = (await dispatch('tool_result', resultEvent(), fakeCtx())) as { isError?: boolean; content?: { text: string }[] };
    expect(patch?.isError).toBe(true);
    expect(patch?.content?.[0]?.text).toContain('unsafe');
  });

  it('appends stashed PreToolUse additionalContext to the result and drains the stash (H1 delivery)', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'c1', 'from pre-hook');
    const { deps } = mkDeps({}, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    const patch = (await dispatch('tool_result', resultEvent(), fakeCtx())) as { content?: { text: string }[] };
    expect(patch?.content?.[0]?.text).toContain('out');
    expect(patch?.content?.[0]?.text).toContain('from pre-hook');
    expect(stash.has('c1')).toBe(false);
  });

  it('drains the stash even when no panel is registered, so a session rebind cannot leak it (M1)', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'c1', 'orphan');
    const { deps } = mkDeps({}, { noPanel: true, preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    expect(await dispatch('tool_result', resultEvent(), fakeCtx())).toBeUndefined();
    expect(stash.has('c1')).toBe(false);
  });

  it('sweeps at agent_end again after the settle, because a segment can orphan an entry each time', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    const { deps } = mkDeps({}, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);

    stashPreToolUseContext(stash, 's1', 'segment-1', 'never resulted');
    await dispatch('agent_end', { messages: [] }, fakeCtx('s1'));
    expect(stash.has('segment-1')).toBe(false);

    stashPreToolUseContext(stash, 's1', 'segment-2', 'never resulted');
    await dispatch('agent_end', { messages: [] }, fakeCtx('s1'));
    expect(stash.has('segment-2')).toBe(false);
  });

  it('sweeps this session\'s orphaned stash entries at agent_end, leaving other sessions untouched (H1)', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'orphan-s1', 'never resulted');
    stashPreToolUseContext(stash, 's2', 'pending-s2', 'other session');
    const { deps } = mkDeps({}, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('agent_end', { messages: [] }, fakeCtx('s1'));
    expect(stash.has('orphan-s1')).toBe(false);
    expect(stash.has('pending-s2')).toBe(true);
  });

  it('sweeps this session\'s orphaned stash entries at session_shutdown, even with no panel (L1)', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'orphan-s1', 'panel closed mid-turn');
    stashPreToolUseContext(stash, 's2', 'pending-s2', 'other session');
    const { deps } = mkDeps({}, { noPanel: true, preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('session_shutdown', { reason: 'closed' }, fakeCtx('s1'));
    expect(stash.has('orphan-s1')).toBe(false);
    expect(stash.has('pending-s2')).toBe(true);
  });

  it('is a no-op when no tool_result hook and no stashed context (FR-14 zero cost — L1)', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    expect(await dispatch('tool_result', resultEvent(), fakeCtx())).toBeUndefined();
  });

  it('surfaces a PostToolUse systemMessage as a notification', async () => {
    const { pi, dispatch } = fakePi();
    const { deps, postMessage } = mkDeps({ tool_result: [nodeEntry('process.stdout.write(JSON.stringify({system_message:"fyi"}))')] });
    registerConfiguredHooks(pi as never, deps);
    await dispatch('tool_result', resultEvent(), fakeCtx());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'fyi' }));
  });
});

/**
 * Stop is the user's "the turn is done" notification, so it has to match what they see: one spinner
 * stopping, one message. pi's `agent_end` fires once per run segment, and both a boundary continuation
 * and an internal pi retry produce several segments for one turn.
 */
describe('Stop cadence (the agent_end config key)', () => {
  /** A hook that appends one byte per invocation, so the file length counts dispatches. */
  function counterEntry(outFile: string): HookEntry {
    return nodeEntry(
      `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").appendFileSync(${JSON.stringify(
        outFile,
      )},"x"))`,
    );
  }

  function tmpFile(tag: string): string {
    const file = path.join(os.tmpdir(), `damocles-stop-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.rmSync(file, { force: true });
    return file;
  }

  const dispatches = (file: string): number => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0);

  it('fires once across a turn that a boundary continuation extended', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = tmpFile('continuation');
    const { deps } = mkDeps({ agent_end: [counterEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      // Segment one ends, the plan-mode nudge holds the run open, segment two ends, then pi settles.
      await dispatch('agent_end', { type: 'agent_end', messages: [] }, fakeCtx());
      await dispatch('agent_before_settle', { type: 'agent_before_settle', entries: [], continue: false }, fakeCtx());
      await dispatch('agent_end', { type: 'agent_end', messages: [] }, fakeCtx());
      expect(dispatches(outFile)).toBe(0);

      await dispatch('agent_settled', { type: 'agent_settled' }, fakeCtx());

      expect(dispatches(outFile)).toBe(1);
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('fires once across a turn pi retried internally', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = tmpFile('retry');
    const { deps } = mkDeps({ agent_end: [counterEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      // A retry re-runs the agent inside the same run, so `agent_end` lands three times with no
      // boundary hold between them. This predates the boundary work and looped the notifier too.
      await dispatch('agent_end', { type: 'agent_end', messages: [] }, fakeCtx());
      await dispatch('agent_end', { type: 'agent_end', messages: [] }, fakeCtx());
      await dispatch('agent_end', { type: 'agent_end', messages: [] }, fakeCtx());

      await dispatch('agent_settled', { type: 'agent_settled' }, fakeCtx());

      expect(dispatches(outFile)).toBe(1);
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('sends the session projection as `messages`, since agent_settled carries none', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = tmpFile('payload');
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(
      outFile,
    )},d))`;
    const { deps } = mkDeps({ agent_end: [nodeEntry(script)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      const projection = [
        { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'shipped' }] },
      ];
      await dispatch('agent_settled', { type: 'agent_settled' }, fakeCtx('s1', projection));

      expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toMatchObject({
        event: 'agent_end',
        session_id: 's1',
        messages: [
          { role: 'user', content: 'ship it' },
          { role: 'assistant', content: 'shipped' },
        ],
      });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('sends an image-only tool result as a marker, never as base64', async () => {
    // The payload is the retained projection, so every screenshot it still holds would otherwise be
    // re-serialised onto the hook's stdin at the end of every turn.
    const { pi, dispatch } = fakePi();
    const outFile = tmpFile('image');
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(
      outFile,
    )},d))`;
    const { deps } = mkDeps({ agent_end: [nodeEntry(script)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      const base64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
      const projection = [
        {
          role: 'toolResult',
          toolName: 'BrowserScreenshot',
          content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
        },
      ];
      await dispatch('agent_settled', { type: 'agent_settled' }, fakeCtx('s1', projection));

      const raw = fs.readFileSync(outFile, 'utf8');
      expect(raw).not.toContain(base64);
      expect(JSON.parse(raw)).toMatchObject({ messages: [{ role: 'toolResult', content: '[image]' }] });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('stays scoped to a registered panel', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = tmpFile('nopanel');
    const { deps } = mkDeps({ agent_end: [counterEntry(outFile)] }, { noPanel: true });
    registerConfiguredHooks(pi as never, deps);
    try {
      await dispatch('agent_settled', { type: 'agent_settled' }, fakeCtx());
      expect(dispatches(outFile)).toBe(0);
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });
});

describe('registerConfiguredHooks — Tier-2 + exclusions (US-007)', () => {
  it('registers Tier-2 events but never the excluded high-frequency ones', () => {
    const { pi, handlers } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    for (const ev of ['model_select', 'turn_end', 'agent_before_settle', 'message_start', 'resources_discover']) {
      expect(handlers.has(ev)).toBe(true);
    }
    for (const ev of ['message_update', 'tool_execution_start', 'tool_execution_end', 'context', 'context_with_system', 'before_provider_request', 'user_bash', 'project_trust']) {
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

  // A reload (e.g. the MCP-driven session.reload() that surfaces newly-connected tools) re-emits
  // session_start/session_shutdown with reason:'reload'. Those are internal runtime rebuilds, not
  // user-meaningful session lifecycle events, so the user's configured hooks must NOT fire for them.
  it('does NOT dispatch session_start for reason:reload (MCP reload must not fire user hooks)', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-reload-start-${process.pid}-${Date.now()}.json`);
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(outFile)},d))`;
    const { deps } = mkDeps({ session_start: [nodeEntry(script)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      await dispatch('session_start', { reason: 'reload' }, fakeCtx());
      expect(fs.existsSync(outFile)).toBe(false); // hook never ran
      // Sanity: a real startup DOES dispatch (the hook runs and writes the payload).
      await dispatch('session_start', { reason: 'startup' }, fakeCtx());
      const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(payload).toMatchObject({ event: 'session_start', reason: 'startup' });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('does NOT dispatch session_shutdown for reason:reload, but still sweeps the orphan stash', async () => {
    const { pi, dispatch } = fakePi();
    const stash = createPreToolUseContextStash();
    stashPreToolUseContext(stash, 's1', 'c1', 'pending');
    const outFile = path.join(os.tmpdir(), `damocles-reload-stop-${process.pid}-${Date.now()}.json`);
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(outFile)},d))`;
    const { deps } = mkDeps({ session_shutdown: [nodeEntry(script)] }, { preToolUseContextStash: stash });
    registerConfiguredHooks(pi as never, deps);
    try {
      await dispatch('session_shutdown', { reason: 'reload' }, fakeCtx('s1'));
      expect(fs.existsSync(outFile)).toBe(false); // user hook never ran
      expect(stash.has('c1')).toBe(false); // but the unconditional orphan sweep still ran
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('drops undrained UserPromptSubmit context when the session ends, but keeps it across a reload', async () => {
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({ input: [nodeEntry('process.stdout.write("inject me")')] });
    registerConfiguredHooks(pi as never, deps);

    await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx('s1'));
    await dispatch('session_shutdown', { reason: 'reload' }, fakeCtx('s1'));
    const afterReload = (await dispatch('before_agent_start', {}, fakeCtx('s1'))) as { message?: { content: string } };
    expect(afterReload?.message?.content).toBe('inject me');

    await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx('s1'));
    await dispatch('session_shutdown', { reason: 'new' }, fakeCtx('s1'));
    expect(await dispatch('before_agent_start', {}, fakeCtx('s1'))).toBeUndefined();
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
    const { pi, dispatch } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-precompact-${process.pid}-${Date.now()}.json`);
    const { deps } = mkDeps({ session_before_compact: [captureEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      await dispatch('session_before_compact', { reason: 'manual', willRetry: false }, fakeCtx());
      const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(payload).toMatchObject({ event: 'session_before_compact', reason: 'manual', will_retry: false });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });

  it('session_compact forwards reason + will_retry + from_extension to the hook stdin', async () => {
    const { pi, dispatch } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-compact-${process.pid}-${Date.now()}.json`);
    const { deps } = mkDeps({ session_compact: [captureEntry(outFile)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      await dispatch('session_compact', { reason: 'overflow', willRetry: true, fromExtension: true }, fakeCtx());
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
    const { pi, dispatch } = fakePi();
    const { deps } = mkDeps({});
    registerConfiguredHooks(pi as never, deps);
    await expect(dispatch('turn_end', {}, fakeCtx())).resolves.toBeUndefined();
  });

  it('runs a configured agent_before_settle hook and still answers undefined', async () => {
    // It is a boundary event, so pi reads the return value: anything but undefined would rewrite the
    // entries and the continuation flag the boundary has already accumulated.
    const { pi, dispatch } = fakePi();
    const outFile = path.join(os.tmpdir(), `damocles-settle-${process.pid}-${Date.now()}.json`);
    const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").writeFileSync(${JSON.stringify(outFile)},d))`;
    const { deps } = mkDeps({ agent_before_settle: [nodeEntry(script)] });
    registerConfiguredHooks(pi as never, deps);
    try {
      const result = await dispatch('agent_before_settle', { type: 'agent_before_settle', entries: [], continue: false }, fakeCtx());
      expect(result).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toMatchObject({ event: 'agent_before_settle' });
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  });
});

describe('registerConfiguredHooks — scope guard', () => {
  it('does nothing when no panel is registered for the session (internal sub-calls)', async () => {
    const { pi, dispatch } = fakePi();
    const { deps, postMessage } = mkDeps({ input: [nodeEntry('process.exit(2)')] }, { noPanel: true });
    registerConfiguredHooks(pi as never, deps);
    expect(await dispatch('input', { source: 'interactive', text: 'hi' }, fakeCtx())).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
