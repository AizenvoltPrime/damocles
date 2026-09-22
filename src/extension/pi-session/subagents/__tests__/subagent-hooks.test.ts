import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createSubagentExtensionFactory, type SubagentGateContext } from '../subagent-extension-factory';
import type { GatePermissionContext } from '../../permission-gate';
import type { DispatchDeps } from '../../hooks';
import type { HookEntry } from '../../hooks/types';
import type { HooksConfigService } from '../../hooks/config';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** Handlers are held per event in registration order, like pi's runner: a one-deep map would let an
 *  accidental second `pi.on` for the same event overwrite the first, which is invisible to every
 *  assertion here. */
function fakePi(): { pi: unknown; handlers: Map<string, Handler[]>; dispatch: Dispatch } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
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

function nodeEntry(script: string): HookEntry {
  return { command: [process.execPath, '-e', script] };
}

function mkDispatch(entriesByKey: Record<string, HookEntry[]>): DispatchDeps {
  const config = {
    getEntries: (k: string) => entriesByKey[k] ?? [],
    hasEntries: (k: string) => (entriesByKey[k] ?? []).length > 0,
  } as unknown as HooksConfigService;
  return { config, workspaceRoot: process.cwd(), userHome: os.homedir() };
}

function makeCtx(plan: boolean, entriesByKey: Record<string, HookEntry[]>): SubagentGateContext {
  return {
    permissionHandler: {
      canUseTool: vi.fn(async () => ({ behavior: 'allow', updatedInput: {} })),
      evaluatePermission: vi.fn(async () => 'allow' as const),
    } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => plan,
    parentToolUseId: 'agent-7',
    // Slice 3 (contract §A) made this field REQUIRED so a future call site that forgets it is a compile
    // error rather than a silent loss of deferral. These hook/pruning cases predate it and are
    // indifferent to it; `[]` keeps them exercising exactly what they always did (no ToolSearch
    // registration), so the assertions below are unchanged.
    deferrableToolNames: [],
    hooks: mkDispatch(entriesByKey),
  };
}

const hookCtx = {
  cwd: process.cwd(),
  signal: undefined,
  sessionManager: {
    getSessionId: () => 'sub1',
    getSessionFile: () => undefined,
    // `agent_settled` carries no messages, so the SubagentStop dispatch reads the projection instead.
    buildSessionProjection: () => ({ messages: [] as unknown[] }),
  },
};

function toolCall(toolName: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_call', toolName, toolCallId: 'c1', input };
}

describe('subagent hooks (US-008)', () => {
  it('a subagent tool_call deny blocks the tool call', async () => {
    const { pi, dispatch } = fakePi();
    const deny = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny",reason:"no"}))');
    createSubagentExtensionFactory(makeCtx(false, { tool_call: [deny] }))(pi as never);
    const result = (await dispatch('tool_call', toolCall('bash', { command: 'ls' }), hookCtx)) as { block?: boolean };
    expect(result?.block).toBe(true);
  });

  it('a subagent tool_call allow force-allows even in inherited plan mode', async () => {
    const { pi, dispatch } = fakePi();
    const allow = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow"}))');
    createSubagentExtensionFactory(makeCtx(true, { tool_call: [allow] }))(pi as never);
    const result = await dispatch('tool_call', toolCall('bash', { command: 'ls' }), hookCtx);
    expect(result).toBeUndefined();
  });

  it('subagent_end fires on agent_settled with the event key + parent_tool_use_id', async () => {
    const marker = path.join(os.tmpdir(), `dam-subend-${process.pid}.txt`);
    fs.rmSync(marker, { force: true });
    const { pi, dispatch } = fakePi();
    const hook = nodeEntry(
      `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);require("fs").writeFileSync(${JSON.stringify(marker)}, j.event+":"+j.parent_tool_use_id)})`,
    );
    createSubagentExtensionFactory(makeCtx(false, { subagent_end: [hook] }))(pi as never);
    await dispatch('agent_settled', { type: 'agent_settled' }, hookCtx);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('subagent_end:agent-7');
    fs.rmSync(marker, { force: true });
  });

  it('subagent_end fires once per subagent run, not once per run segment', async () => {
    // A subagent that pi retries internally emits several `agent_end` events for one run. The user's
    // notification has to match the one result the parent gets back.
    const marker = path.join(os.tmpdir(), `dam-subend-count-${process.pid}-${Date.now()}.txt`);
    fs.rmSync(marker, { force: true });
    const { pi, dispatch } = fakePi();
    const hook = nodeEntry(
      `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>require("fs").appendFileSync(${JSON.stringify(marker)},"x"))`,
    );
    createSubagentExtensionFactory(makeCtx(false, { subagent_end: [hook] }))(pi as never);

    await dispatch('agent_end', { type: 'agent_end', messages: [] }, hookCtx);
    await dispatch('agent_end', { type: 'agent_end', messages: [] }, hookCtx);
    expect(fs.existsSync(marker)).toBe(false);

    await dispatch('agent_settled', { type: 'agent_settled' }, hookCtx);

    expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
    fs.rmSync(marker, { force: true });
  });

  it('registers no hook handlers when no dispatch deps are supplied', () => {
    const { pi, handlers } = fakePi();
    createSubagentExtensionFactory({
      permissionHandler: {} as unknown as GatePermissionContext['permissionHandler'],
      isPlanMode: () => false,
      parentToolUseId: 'agent-7',
      deferrableToolNames: [],
    })(pi as never);
    expect(handlers.has('tool_call')).toBe(true);
    expect(handlers.has('tool_result')).toBe(false);
    expect(handlers.has('agent_end')).toBe(false);
    expect(handlers.has('agent_settled')).toBe(false);
  });

  it('the subagent PreToolUse sweep still runs per run segment', async () => {
    const { pi, dispatch } = fakePi();
    createSubagentExtensionFactory(makeCtx(false, { tool_call: [nodeEntry('process.stdout.write(JSON.stringify({decision:"allow",context:"note"}))')] }))(pi as never);

    await dispatch('tool_call', toolCall('bash', { command: 'ls' }), hookCtx);
    await dispatch('agent_end', { type: 'agent_end', messages: [] }, hookCtx);
    // Swept, so the stash no longer delivers it onto a late-arriving result.
    const patch = await dispatch('tool_result', 
      { type: 'tool_result', toolCallId: 'c1', toolName: 'bash', input: {}, content: [{ type: 'text', text: 'out' }], isError: false, details: undefined },
      hookCtx,
    );
    expect(patch).toBeUndefined();
  });
});

describe('subagent context image pruning', () => {
  const bareCtx = (): SubagentGateContext => ({
    permissionHandler: {} as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => false,
    parentToolUseId: 'agent-7',
    deferrableToolNames: [],
  });

  /** One projected tool-result entry per screenshot, as `turn_end` hands them over. */
  const projected = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      sourceEntry: { id: `t${i}` },
      messages: [
        {
          role: 'toolResult' as const,
          toolCallId: `t${i}`,
          toolName: 'BrowserScreenshot',
          content: [{ type: 'image' as const, data: `d${i}`, mimeType: 'image/jpeg' }],
          isError: false,
          timestamp: 0,
        },
      ],
    }));

  const turnEnd = (contextEntries: unknown[]) => ({
    type: 'turn_end',
    entries: [],
    continue: false,
    context: { contextEntries, contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
    outcome: 'completed',
    turnIndex: 0,
    toolResults: [],
    messageEntryId: 'a1',
    toolResultEntryIds: [],
  });

  it('registers both pruning seams even without dispatch deps', () => {
    const { pi, handlers } = fakePi();
    createSubagentExtensionFactory(bareCtx())(pi as never);
    expect(handlers.has('turn_end')).toBe(true);
    expect(handlers.has('before_agent_start')).toBe(true);
    expect(handlers.has('context')).toBe(false);
  });

  it('the turn_end handler returns context_edit drafts for the oldest screenshots', async () => {
    const { pi, dispatch } = fakePi();
    createSubagentExtensionFactory(bareCtx())(pi as never);

    const result = (await dispatch('turn_end', turnEnd(projected(13)), hookCtx)) as {
      entries: Array<{ type: string; targetId: string }>;
    };

    expect(result.entries.map((e) => e.targetId)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(result.entries.every((e) => e.type === 'context_edit')).toBe(true);
  });

  it('the before_agent_start reconcile appends the missing edits', async () => {
    const { pi, dispatch } = fakePi();
    createSubagentExtensionFactory(bareCtx())(pi as never);
    const appendContextEdit = vi.fn();

    await dispatch('before_agent_start', { type: 'before_agent_start', prompt: 'go' }, {
      ...hookCtx,
      sessionManager: { ...hookCtx.sessionManager, buildSessionProjection: () => ({ entries: projected(13) }), appendContextEdit },
    });

    expect(appendContextEdit).toHaveBeenCalledTimes(6);
  });

  it('fails soft: a thrown pruning error yields undefined', async () => {
    const { pi, dispatch } = fakePi();
    createSubagentExtensionFactory(bareCtx())(pi as never);
    expect(await dispatch('turn_end', turnEnd([{ sourceEntry: { id: 'x' } }]), hookCtx)).toBeUndefined();
  });
});
