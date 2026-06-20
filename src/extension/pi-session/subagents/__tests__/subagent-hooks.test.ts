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

function fakePi(): { pi: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return { pi: { on: (event: string, handler: Handler) => handlers.set(event, handler) }, handlers };
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
    hooks: mkDispatch(entriesByKey),
  };
}

const hookCtx = {
  cwd: process.cwd(),
  signal: undefined,
  sessionManager: { getSessionId: () => 'sub1', getSessionFile: () => undefined },
};

function toolCall(toolName: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_call', toolName, toolCallId: 'c1', input };
}

describe('subagent hooks (US-008)', () => {
  it('a subagent tool_call deny blocks the tool call', async () => {
    const { pi, handlers } = fakePi();
    const deny = nodeEntry('process.stdout.write(JSON.stringify({decision:"deny",reason:"no"}))');
    createSubagentExtensionFactory(makeCtx(false, { tool_call: [deny] }))(pi as never);
    const result = (await handlers.get('tool_call')!(toolCall('bash', { command: 'ls' }), hookCtx)) as { block?: boolean };
    expect(result?.block).toBe(true);
  });

  it('a subagent tool_call allow force-allows even in inherited plan mode', async () => {
    const { pi, handlers } = fakePi();
    const allow = nodeEntry('process.stdout.write(JSON.stringify({decision:"allow"}))');
    createSubagentExtensionFactory(makeCtx(true, { tool_call: [allow] }))(pi as never);
    const result = await handlers.get('tool_call')!(toolCall('bash', { command: 'ls' }), hookCtx);
    expect(result).toBeUndefined();
  });

  it('subagent_end fires on agent_end with the event key + parent_tool_use_id', async () => {
    const marker = path.join(os.tmpdir(), `dam-subend-${process.pid}.txt`);
    fs.rmSync(marker, { force: true });
    const { pi, handlers } = fakePi();
    const hook = nodeEntry(
      `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);require("fs").writeFileSync(${JSON.stringify(marker)}, j.event+":"+j.parent_tool_use_id)})`,
    );
    createSubagentExtensionFactory(makeCtx(false, { subagent_end: [hook] }))(pi as never);
    await handlers.get('agent_end')!({ type: 'agent_end', messages: [] }, hookCtx);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('subagent_end:agent-7');
    fs.rmSync(marker, { force: true });
  });

  it('registers no hook handlers when no dispatch deps are supplied', () => {
    const { pi, handlers } = fakePi();
    createSubagentExtensionFactory({
      permissionHandler: {} as unknown as GatePermissionContext['permissionHandler'],
      isPlanMode: () => false,
      parentToolUseId: 'agent-7',
    })(pi as never);
    expect(handlers.has('tool_call')).toBe(true);
    expect(handlers.has('tool_result')).toBe(false);
    expect(handlers.has('agent_end')).toBe(false);
  });
});
