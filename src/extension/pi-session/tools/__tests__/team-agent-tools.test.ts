import { describe, it, expect } from 'vitest';
import { Value } from 'typebox/value';
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
    redispatchSpecialist: (_name: string, _task: string, _profileId?: string, _kind?: 'implementor' | 'reviewer') => 'spec-id',
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
    checkMessageDeliverable: () => ({ ok: true }),
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

describe('team_redispatch_specialist — lead-only re-run (Slice C)', () => {
  it('is registered as a team agent tool', () => {
    expect(toolMap(leadCtx()).has('team_redispatch_specialist')).toBe(true);
  });

  it('calls ctx.redispatchSpecialist with (name, task, profile, kind) and reports success (lead)', async () => {
    const calls: unknown[][] = [];
    const ctx = leadCtx({
      redispatchSpecialist: (...args: unknown[]) => { calls.push(args); return 're-id'; },
    });
    const redispatch = toolMap(ctx).get('team_redispatch_specialist')!;
    const res = await redispatch.execute('id', { name: 'Dev', task: 'redo the task with more detail here', kind: 'reviewer', profile: 'engineering-code-reviewer' });
    expect(calls).toEqual([['Dev', 'redo the task with more detail here', 'engineering-code-reviewer', 'reviewer']]);
    expect(res.content[0].text).toMatch(/re-dispatched/);
  });

  it('forwards undefined profile when omitted', async () => {
    const calls: unknown[][] = [];
    const ctx = leadCtx({
      redispatchSpecialist: (...args: unknown[]) => { calls.push(args); return 're-id'; },
    });
    const redispatch = toolMap(ctx).get('team_redispatch_specialist')!;
    await redispatch.execute('id', { name: 'Dev', task: 'redo the task with more detail here', kind: 'implementor' });
    expect(calls).toEqual([['Dev', 'redo the task with more detail here', undefined, 'implementor']]);
  });

  it('rejects a specialist calling redispatch (lead-only)', async () => {
    const redispatch = toolMap(specialistCtx()).get('team_redispatch_specialist')!;
    await expect(
      redispatch.execute('id', { name: 'Dev', task: 'redo the task with more detail here', kind: 'implementor' }),
    ).rejects.toThrow(/Only the lead/);
  });

  it('surfaces the runner guard error (e.g. redispatch of a completed specialist)', async () => {
    const ctx = leadCtx({
      redispatchSpecialist: () => { throw new Error('Agent "Dev" is completed — approved work is final'); },
    });
    const redispatch = toolMap(ctx).get('team_redispatch_specialist')!;
    await expect(
      redispatch.execute('id', { name: 'Dev', task: 'redo the task with more detail here', kind: 'implementor' }),
    ).rejects.toThrow(/approved work is final/);
  });
});

describe('team_redispatch_specialist — schema mirrors team_spawn_specialist', () => {
  const redispatch = toolMap(leadCtx()).get('team_redispatch_specialist')!;

  it('exposes exactly name/task/kind/profile (no model)', () => {
    const props = (redispatch.parameters as unknown as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('model');
    expect(Object.keys(props).sort()).toEqual(['kind', 'name', 'profile', 'task']);
  });

  it('accepts a valid redispatch call (name, task ≥ MIN_TASK_LENGTH, kind; optional profile)', () => {
    expect(Value.Check(redispatch.parameters, { name: 'Dev', task: 'redo the task with more detail here', kind: 'implementor' })).toBe(true);
    expect(Value.Check(redispatch.parameters, { name: 'Dev', task: 'redo the task with more detail here', kind: 'reviewer', profile: 'p' })).toBe(true);
  });

  it('rejects a task below MIN_TASK_LENGTH', () => {
    expect(Value.Check(redispatch.parameters, { name: 'Dev', task: 'too short', kind: 'implementor' })).toBe(false);
  });

  it('rejects a missing kind (kind is REQUIRED)', () => {
    expect(Value.Check(redispatch.parameters, { name: 'Dev', task: 'redo the task with more detail here' })).toBe(false);
  });

  it('rejects an unknown kind value', () => {
    expect(Value.Check(redispatch.parameters, { name: 'Dev', task: 'redo the task with more detail here', kind: 'observer' })).toBe(false);
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

describe('team_send_message — fail-loud deliverability (Slice B)', () => {
  /** A message bus that records every send so tests can assert the tool did/did not deliver. */
  function recordingBus() {
    const sends: Array<{ from: string; to: string; content: string }> = [];
    const bus = {
      send: (from: string, to: string, content: string) => {
        sends.push({ from, to, content });
        return { messageId: `m${sends.length}` };
      },
      getInbox: () => [],
      broadcast: () => undefined,
      getAllMessages: () => sends.map((s, i) => ({ messageId: `m${i + 1}`, ...s })),
      subscribe: () => () => undefined,
    } as unknown as AgentMcpContext['messageBus'];
    return { bus, sends };
  }

  it('THROWS TeamToolError (surfacing the error) and does NOT send when checkMessageDeliverable returns { ok:false }', async () => {
    const { bus, sends } = recordingBus();
    const ctx = leadCtx({
      messageBus: bus,
      checkMessageDeliverable: () => ({ ok: false, error: 'Cannot message \'Dev\' — undeliverable sentinel' }),
    });
    const send = toolMap(ctx).get('team_send_message')!;
    await expect(send.execute('id', { to: 'Dev', content: 'hello' })).rejects.toThrow(/undeliverable sentinel/);
    // Nothing appended to the bus.
    expect(sends).toHaveLength(0);
    expect((bus.getAllMessages() as unknown[]).length).toBe(0);
  });

  it('sends exactly one message and reports success when checkMessageDeliverable returns { ok:true }', async () => {
    const { bus, sends } = recordingBus();
    const ctx = leadCtx({ messageBus: bus, checkMessageDeliverable: () => ({ ok: true }) });
    const send = toolMap(ctx).get('team_send_message')!;
    const res = await send.execute('id', { to: 'Dev', content: 'hello' });
    expect(sends).toEqual([{ from: 'Lead', to: 'Dev', content: 'hello' }]);
    expect(res.content[0].text).toMatch(/Message sent/);
  });

  it('order: self-send error fires BEFORE deliverability (checkMessageDeliverable is never consulted)', async () => {
    let consulted = false;
    const { bus, sends } = recordingBus();
    const ctx = leadCtx({
      messageBus: bus,
      checkMessageDeliverable: () => { consulted = true; throw new Error('deliverability must not run for self-send'); },
    });
    const send = toolMap(ctx).get('team_send_message')!;
    // Lead sending to itself ('Lead').
    await expect(send.execute('id', { to: 'Lead', content: 'hi me' })).rejects.toThrow(/yourself/);
    expect(consulted).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it('order: unknown-roster error fires BEFORE deliverability (checkMessageDeliverable is never consulted)', async () => {
    let consulted = false;
    const { bus, sends } = recordingBus();
    const ctx = leadCtx({
      messageBus: bus,
      getAgentNames: () => ['Lead', 'Dev'],
      checkMessageDeliverable: () => { consulted = true; throw new Error('deliverability must not run for unknown roster'); },
    });
    const send = toolMap(ctx).get('team_send_message')!;
    await expect(send.execute('id', { to: 'Ghost', content: 'anyone?' })).rejects.toThrow(/Unknown agent/);
    expect(consulted).toBe(false);
    expect(sends).toHaveLength(0);
  });

  describe('per-status behaviour (tool mechanics only — verbatim guidance strings are pinned against the REAL TeamRunner.checkMessageDeliverable in team-runner.test.ts)', () => {
    function deliverableFor(status: TeamAgent['status']): { ok: boolean; error?: string } {
      const deliverable = ['running', 'awaiting-review', 'standby', 'monitoring'].includes(status);
      return deliverable ? { ok: true } : { ok: false, error: `undeliverable sentinel (${status})` };
    }

    const deliverableStatuses: Array<TeamAgent['status']> = ['running', 'awaiting-review', 'standby', 'monitoring'];
    const undeliverableStatuses: Array<TeamAgent['status']> = ['pending', 'completed', 'failed', 'cancelled'];

    it.each(deliverableStatuses)('recipient status %s → success, exactly one send', async (status) => {
      const { bus, sends } = recordingBus();
      const ctx = leadCtx({ messageBus: bus, checkMessageDeliverable: () => deliverableFor(status) });
      const send = toolMap(ctx).get('team_send_message')!;
      const res = await send.execute('id', { to: 'Dev', content: 'ping' });
      expect(sends).toHaveLength(1);
      expect(res.content[0].text).toMatch(/Message sent/);
    });

    it.each(undeliverableStatuses)('recipient status %s → surfaces the ctx error verbatim, no send', async (status) => {
      const { bus, sends } = recordingBus();
      const ctx = leadCtx({ messageBus: bus, checkMessageDeliverable: () => deliverableFor(status) });
      const send = toolMap(ctx).get('team_send_message')!;
      await expect(send.execute('id', { to: 'Dev', content: 'ping' })).rejects.toThrow(`undeliverable sentinel (${status})`);
      expect(sends).toHaveLength(0);
    });
  });
});
