import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { toast } from 'vue-sonner';
import { createPermissionHandlers } from '../permission-handlers';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import type { HandlerContext } from '../../types';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { PromptOwner } from '@shared/types/permissions';

vi.mock('vue-sonner', () => ({ toast: { info: vi.fn() } }));

const MAIN: PromptOwner = { kind: 'main' };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(toast.info).mockClear();
});

describe('requestPermission', () => {
  it('keeps the tool input on the pending permission, which the generic prompt shows', () => {
    const ctx = {
      stores: { permissionStore: usePermissionStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore() },
    } as unknown as HandlerContext;
    const msg: ExtensionToWebviewMessage = { type: 'requestPermission', toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'notes/a.txt' }, owner: MAIN };
    createPermissionHandlers().requestPermission!(msg as never, ctx);

    expect(usePermissionStore().currentPermission).toMatchObject({ toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'notes/a.txt' } });
  });
});

describe('a prompt marks only the card of the agent core names as its owner', () => {
  const TEAM: PromptOwner = { kind: 'team', teamId: 'team-1', agentId: 'agent-1', teamTitle: 'Lockout', agentName: 'Mira' };
  const SUBAGENT: PromptOwner = { kind: 'subagent', agentId: 'sub-1' };

  const setup = () => {
    const ctx = {
      stores: { permissionStore: usePermissionStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore() },
    } as unknown as HandlerContext;
    const handlers = createPermissionHandlers();
    const ask = (owner: PromptOwner, parentToolUseId?: string) =>
      handlers.requestPermission!({ type: 'requestPermission', toolUseId: 'b1', toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', owner, ...(parentToolUseId ? { parentToolUseId } : {}) }, ctx);
    const withdraw = () =>
      handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId: 'b1' }, ctx);
    const mainCard = () => useStreamingStore().messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 'b1');
    const subagentCard = () => useSubagentStore().subagents['call-agent']?.toolCalls.find((t) => t.id === 'b1');
    return { ask, withdraw, mainCard, subagentCard };
  };

  it("marks the main agent's card awaiting approval", () => {
    const { ask, mainCard } = setup();
    ask(MAIN);
    expect(mainCard()?.status).toBe('awaiting_approval');
  });

  it("adds the call to its subagent's card and not to the transcript", () => {
    const { ask, mainCard, subagentCard } = setup();
    useSubagentStore().registerAgentTool('call-agent', { description: 'Survey the repo', subagent_type: 'Explore' });

    ask(SUBAGENT, 'call-agent');

    expect(subagentCard()?.status).toBe('awaiting_approval');
    expect(mainCard()).toBeUndefined();
    expect(usePermissionStore().currentPermission).toMatchObject({ owner: SUBAGENT, agentDescription: 'Survey the repo' });
  });

  it("moves a subagent's call that pi already started to awaiting approval", () => {
    const { ask, subagentCard } = setup();
    useSubagentStore().registerAgentTool('call-agent', { description: 'Survey the repo', subagent_type: 'Explore' });
    useSubagentStore().addToolCallToSubagent('call-agent', { id: 'b1', name: 'Bash', input: { command: 'ls' }, status: 'running' });

    ask(SUBAGENT, 'call-agent');

    expect(subagentCard()?.status).toBe('awaiting_approval');
  });

  it('adds no card anywhere for a subagent the store does not hold', () => {
    const { ask, mainCard } = setup();
    ask(SUBAGENT, 'call-agent');

    expect(mainCard()).toBeUndefined();
    expect(useSubagentStore().subagents).toEqual({});
    expect(usePermissionStore().currentPermission).toMatchObject({ toolUseId: 'b1', owner: SUBAGENT });
  });

  it("adds no transcript card for a team agent's call, whose card is in the team view", () => {
    const { ask, mainCard } = setup();
    ask(TEAM, 'agent-7');

    expect(mainCard()).toBeUndefined();
    expect(useStreamingStore().toolStatusCache.size).toBe(0);
    expect(usePermissionStore().currentPermission).toMatchObject({ toolUseId: 'b1', owner: TEAM });
  });

  it("leaves no status behind when a team agent's prompt is withdrawn", () => {
    const { ask, withdraw, mainCard } = setup();
    ask(TEAM, 'agent-7');

    withdraw();

    expect(usePermissionStore().currentPermission).toBeNull();
    expect(useStreamingStore().toolStatusCache.size).toBe(0);
    useStreamingStore().addToolCall({ id: 'b1', name: 'Bash', input: { command: 'ls' } });
    expect(mainCard()?.status).toBe('pending');
  });

});

describe('requestPlanApproval', () => {
  it('records the version core stamped on the plan card and the pending plan', () => {
    const streamingStore = useStreamingStore();
    const ctx = { stores: { permissionStore: usePermissionStore(), streamingStore } } as unknown as HandlerContext;
    streamingStore.addToolCall({ id: 'p3', name: 'ExitPlanMode', input: {} });

    createPermissionHandlers().requestPlanApproval!({ type: 'requestPlanApproval', toolUseId: 'p3', planContent: '1. Ship', planVersion: 3, owner: MAIN }, ctx);

    expect(streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 'p3')?.metadata).toEqual({ planVersion: 3 });
    expect(usePermissionStore().pendingPlanApproval).toEqual({ toolUseId: 'p3', planContent: '1. Ship', planVersion: 3 });
  });
});

describe('permissionAutoResolved', () => {
  const setup = () => {
    const ctx = {
      stores: { permissionStore: usePermissionStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore() },
    } as unknown as HandlerContext;
    const handlers = createPermissionHandlers();
    handlers.requestPermission!({ type: 'requestPermission', toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'README.md' }, owner: MAIN }, ctx);
    const status = () => useStreamingStore().messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 'r1')?.status;
    return { ctx, handlers, status };
  };

  it.each([
    ['after', true],
    ['before', false],
  ])('clears a prompt that Stop withdrew, arriving %s the abandon, without marking the call approved', (_label, abandonFirst) => {
    const { ctx, handlers, status } = setup();
    if (abandonFirst) useStreamingStore().updateToolStatus('r1', 'abandoned');

    handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId: 'r1', parentToolUseId: null }, ctx);
    expect(status()).not.toBe('approved');
    expect(usePermissionStore().currentPermission).toBeNull();

    if (!abandonFirst) useStreamingStore().updateToolStatus('r1', 'abandoned');
    expect(status()).toBe('abandoned');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('closes the open prompts a mode approved with one notice naming the mode, and none for a prompt already answered', () => {
    const { ctx, handlers } = setup();
    handlers.requestPermission!({ type: 'requestPermission', toolUseId: 'r2', toolName: 'Edit', toolInput: { file_path: 'a.ts' }, owner: MAIN }, ctx);
    handlers.requestSkillApproval!({ type: 'requestSkillApproval', toolUseId: 's1', skillName: 'simplify', owner: MAIN }, ctx);

    for (const toolUseId of ['r1', 'r2', 's1']) {
      handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId, parentToolUseId: null, approvedBy: 'yolo' }, ctx);
    }
    handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId: 'answered', parentToolUseId: null, approvedBy: 'acceptEdits' }, ctx);

    expect(usePermissionStore().currentPermission).toBeNull();
    expect(usePermissionStore().pendingSkillApproval).toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(3);
    expect(new Set(vi.mocked(toast.info).mock.calls.map(([, options]) => (options as { id: string }).id))).toEqual(new Set(['prompts-approved-yolo']));
    expect(toast.info).toHaveBeenCalledWith('YOLO approved the open prompts it no longer asks about', { id: 'prompts-approved-yolo' });
  });
});
