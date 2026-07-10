import { describe, it, expect } from 'vitest';
import type { TSchema } from 'typebox';
import type { PiCodingAgentModule } from '../../pi-loader';
import { buildTeamAgentPiTools } from '../team-tools';
import type { AgentMcpContext } from '../../../team/types';

type PiTool = {
  name: string;
  parameters: TSchema;
  execute: (id: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }>;
};

const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

/** A permissive lead context; individual tests override the fields they exercise. */
function leadCtx(over: Partial<AgentMcpContext> = {}): AgentMcpContext {
  return {
    agentId: 'lead-id',
    agentName: 'Lead',
    role: 'lead',
    messageBus: { send: () => ({ messageId: 'm' }), getInbox: () => [], broadcast: () => undefined, getAllMessages: () => [], subscribe: () => () => undefined } as unknown as AgentMcpContext['messageBus'],
    scratchpad: {} as AgentMcpContext['scratchpad'],
    startSpecialist: (_name: string, _task: string, _profileId?: string, _kind?: 'implementor' | 'reviewer') => 'spec-id',
    checkBriefReadGate: () => ({ ok: true }),
    synthesizeResult: () => undefined,
    cancelSpecialist: () => undefined,
    getActiveSpecialistNames: () => [],
    getPendingSpecialistNames: () => [],
    getTeamStatus: () => ({ agents: [] }),
    getAgentNames: () => ['Lead', 'Dev'],
    requestRevision: () => undefined,
    approveSpecialist: () => undefined,
    getUnreviewedSpecialistNames: () => [],
    isReviewRoundReady: () => true,
    getNonSettledSpecialistDetails: () => [],
    getAllAgents: () => [],
    enterStandby: () => undefined,
    reportComplete: () => undefined,
    flagBriefConflict: () => undefined,
    resolveBriefConflict: () => undefined,
    getOpenBriefConflicts: () => [],
    ...over,
  } as AgentMcpContext;
}

function specialistCtx(over: Partial<AgentMcpContext> = {}): AgentMcpContext {
  return leadCtx({ role: 'specialist', agentName: 'Dev', agentId: 'dev-id', ...over });
}

function toolMap(ctx: AgentMcpContext): Map<string, PiTool> {
  const tools = buildTeamAgentPiTools(pi, ctx) as unknown as PiTool[];
  return new Map(tools.map((t) => [t.name, t]));
}

describe('team_spawn_specialist — brief read-gate', () => {
  it('throws the read-the-brief error when the lead has not read mission-brief', async () => {
    const ctx = leadCtx({ checkBriefReadGate: () => ({ ok: false, error: 'read the `mission-brief` section first' }) });
    const spawn = toolMap(ctx).get('team_spawn_specialist')!;
    await expect(
      spawn.execute('id', { name: 'Dev', task: 'do a well-described task here', kind: 'implementor' }),
    ).rejects.toThrow(/mission-brief/);
  });

  it('spawns after the brief read-gate passes, forwarding name/task/profile/kind (no model)', async () => {
    const calls: unknown[][] = [];
    const ctx = leadCtx({
      checkBriefReadGate: () => ({ ok: true }),
      startSpecialist: (...args: unknown[]) => { calls.push(args); return 'spec-id'; },
    });
    const spawn = toolMap(ctx).get('team_spawn_specialist')!;
    await spawn.execute('id', { name: 'Dev', task: 'do a well-described task here', kind: 'reviewer', profile: 'engineering-code-reviewer' });
    expect(calls).toEqual([['Dev', 'do a well-described task here', 'engineering-code-reviewer', 'reviewer']]);
  });

  it('rejects a specialist calling spawn (lead-only) before touching the gate', async () => {
    const spawn = toolMap(specialistCtx()).get('team_spawn_specialist')!;
    await expect(
      spawn.execute('id', { name: 'Dev', task: 'do a well-described task here', kind: 'implementor' }),
    ).rejects.toThrow(/Only the lead/);
  });
});

describe('team_spawn_specialist — schema has NO `model` property', () => {
  it('exposes only name/task/kind/profile (the model arg is removed)', () => {
    const spawn = toolMap(leadCtx()).get('team_spawn_specialist')!;
    const props = (spawn.parameters as unknown as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('model');
    expect(Object.keys(props).sort()).toEqual(['kind', 'name', 'profile', 'task']);
  });
});

describe('team_flag_brief_conflict — specialist-only', () => {
  it('records the flag via the context (specialist)', async () => {
    const flagged: Array<{ name: string; detail: string }> = [];
    const ctx = specialistCtx({ flagBriefConflict: (name, detail) => flagged.push({ name, detail }) });
    const flag = toolMap(ctx).get('team_flag_brief_conflict')!;
    await flag.execute('id', { detail: 'brief mandates async pipeline; contract says sync toy endpoint' });
    expect(flagged).toEqual([{ name: 'Dev', detail: 'brief mandates async pipeline; contract says sync toy endpoint' }]);
  });

  it('rejects the lead flagging (specialist-only)', async () => {
    const flag = toolMap(leadCtx()).get('team_flag_brief_conflict')!;
    await expect(flag.execute('id', { detail: 'some ten-plus char detail' })).rejects.toThrow(/Only a specialist/);
  });
});

describe('team_resolve_brief_conflict — lead-only', () => {
  it('resolves via the context (lead)', async () => {
    const resolved: Array<{ name: string; resolution: string }> = [];
    const ctx = leadCtx({ resolveBriefConflict: (name, resolution) => resolved.push({ name, resolution }) });
    const resolve = toolMap(ctx).get('team_resolve_brief_conflict')!;
    await resolve.execute('id', { name: 'Dev', resolution: 'intentional deviation — accepted, documented in synthesis' });
    expect(resolved).toEqual([{ name: 'Dev', resolution: 'intentional deviation — accepted, documented in synthesis' }]);
  });

  it('rejects a specialist resolving (lead-only)', async () => {
    const resolve = toolMap(specialistCtx()).get('team_resolve_brief_conflict')!;
    await expect(resolve.execute('id', { name: 'Dev', resolution: 'ten-plus char resolution' })).rejects.toThrow(/Only the lead/);
  });
});

describe('team_synthesize_result — conflict gate', () => {
  it('blocks explicit synthesis while a brief conflict is open, naming the conflict', async () => {
    const ctx = leadCtx({ getOpenBriefConflicts: () => [{ name: 'Dev', detail: 'async vs sync mismatch' }] });
    const synth = toolMap(ctx).get('team_synthesize_result')!;
    await expect(synth.execute('id', { result: 'done' })).rejects.toThrow(/unresolved brief conflicts: Dev \(async vs sync mismatch\)/);
  });

  it('allows synthesis once no conflict is open', async () => {
    let synthesized: string | null = null;
    const ctx = leadCtx({
      getOpenBriefConflicts: () => [],
      synthesizeResult: (r) => { synthesized = r; },
    });
    const synth = toolMap(ctx).get('team_synthesize_result')!;
    await synth.execute('id', { result: 'all good' });
    expect(synthesized).toBe('all good');
  });
});
