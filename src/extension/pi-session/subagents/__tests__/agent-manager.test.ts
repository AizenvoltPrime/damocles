import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AgentManager, type SubagentEngine, type SpawnSpec } from '../agent-manager';
import { AgentRegistry } from '../agent-types';
import { STEER_INSTRUCTION_PREFIX } from '../../../../shared/steer';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Gate {
  resolve: () => void;
}

/** A fake engine whose subagent sessions block on a per-spawn gate the test resolves to control timing. */
function makeEngine(): { engine: SubagentEngine; gates: Gate[] } {
  const gates: Gate[] = [];
  const engine: SubagentEngine = {
    cwd: '/ws',
    registry: new AgentRegistry(),
    createSession: async () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      gates.push({ resolve });
      const session = {
        subscribe: () => () => {},
        prompt: () => promise,
        messages: [],
        getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        getLastAssistantText: () => '',
        setSessionName: () => {},
        setAutoCompactionEnabled: () => {},
        steer: async () => {},
        abort: async () => {},
        dispose: () => {},
        sessionId: 'sid',
      };
      return session as unknown as AgentSession;
    },
    forgetSession: () => {},
    permissionHandler: {} as never,
    isPlanMode: () => false,
    postMessage: () => {},
    getParentSystemPrompt: () => '',
    getParentSessionId: () => 'parent-sid',
    parentFullToolNames: () => ['read'],
    buildSubagentCustomTools: () => [],
    resolveModel: () => ({}),
    onSubagentCost: () => {},
  };
  return { engine, gates };
}

function spec(i: number): SpawnSpec {
  return { type: 'general-purpose', prompt: `task ${i}`, description: `d${i}`, toolCallId: `tc${i}`, runInBackground: true };
}

describe('AgentManager concurrency', () => {
  it('runs up to maxConcurrent background agents and queues the overflow, draining as slots free', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    const ids = [0, 1, 2, 3].map((i) => mgr.spawn(spec(i)));

    // First two start running immediately; the rest queue (checked synchronously).
    expect(mgr.getRecord(ids[0])!.status).toBe('running');
    expect(mgr.getRecord(ids[1])!.status).toBe('running');
    expect(mgr.getRecord(ids[2])!.status).toBe('queued');
    expect(mgr.getRecord(ids[3])!.status).toBe('queued');

    await flush(); // let the two running agents create their sessions
    expect(gates).toHaveLength(2);

    // Finish the first agent → a queued one drains into the freed slot.
    gates[0].resolve();
    await flush();
    expect(mgr.getRecord(ids[0])!.status).toBe('completed');
    expect(mgr.getRecord(ids[2])!.status).toBe('running');
    expect(mgr.getRecord(ids[3])!.status).toBe('queued');
    await flush();
    expect(gates).toHaveLength(3);

    // Drain the rest.
    gates[1].resolve();
    await flush();
    gates[2].resolve();
    await flush();
    await flush();
    if (gates[3]) gates[3].resolve();
    await flush();
    expect(mgr.hasRunning()).toBe(false);
    mgr.dispose();
  });

  it('foreground spawns honor the shared concurrency cap, queueing the overflow', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const fg = (i: number): SpawnSpec => ({ ...spec(i), runInBackground: false });

    const p0 = mgr.spawnAndWait(fg(0));
    const p1 = mgr.spawnAndWait(fg(1));
    const p2 = mgr.spawnAndWait(fg(2)); // over the cap → must wait for a slot, not launch immediately

    await flush();
    expect(gates).toHaveLength(2); // only two nested sessions launched; the third is queued

    gates[0].resolve();
    await flush();
    await flush();
    expect(gates).toHaveLength(3); // the freed slot drains the queued foreground spawn

    gates[1].resolve();
    gates[2].resolve();
    await flush();
    await flush();
    const records = await Promise.all([p0, p1, p2]);
    expect(records.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    mgr.dispose();
  });

  it('a queued spawn resolves its lifetime promise only after it drains and completes', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1)); // queued (cap = 1)
    expect(mgr.getRecord(b)!.status).toBe('queued');

    let resolved = false;
    void mgr.getRecord(b)!.promise!.then(() => { resolved = true; });

    await flush();
    expect(resolved).toBe(false); // must NOT resolve while still queued (the High-severity bug)

    gates[0].resolve(); // first agent completes → b drains into the freed slot
    await flush();
    await flush();
    expect(mgr.getRecord(b)!.status).toBe('running');
    expect(resolved).toBe(false);

    gates[1].resolve(); // b completes
    await flush();
    await flush();
    expect(resolved).toBe(true);
    mgr.dispose();
  });

  it('aborting a queued spawn settles its lifetime promise', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1));
    await flush();

    let settled = false;
    void mgr.getRecord(b)!.promise!.then(() => { settled = true; });
    mgr.abort(b);
    await flush();

    expect(settled).toBe(true);
    expect(mgr.getRecord(b)!.status).toBe('stopped');
    mgr.dispose();
  });

  it('rejects an unknown subagent type with a distinct error instead of silently running general-purpose', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const rec = await mgr.spawnAndWait({ ...spec(0), type: 'does-not-exist', runInBackground: false });
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('Unknown or disabled');
    expect(gates).toHaveLength(0); // no nested session was ever created
    mgr.dispose();
  });

  it('rejects an explicitly disabled agent type', async () => {
    const { engine, gates } = makeEngine();
    engine.registry.register(
      new Map([
        ['Disabled', { name: 'Disabled', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, enabled: false }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    const rec = await mgr.spawnAndWait({ ...spec(0), type: 'Disabled', runInBackground: false });
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('Unknown or disabled');
    expect(gates).toHaveLength(0);
    mgr.dispose();
  });

  it('abortAll stops running and queued agents', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    const a = mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1));
    await flush();
    const count = mgr.abortAll();
    expect(count).toBe(2);
    expect(mgr.getRecord(a)!.status).toBe('stopped');
    expect(mgr.getRecord(b)!.status).toBe('stopped');
    mgr.dispose();
  });

  it('clearCompleted drops finished records but keeps running ones', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const a = mgr.spawn(spec(0));
    await flush();
    gates[0].resolve();
    await flush();
    expect(mgr.getRecord(a)!.status).toBe('completed');
    mgr.clearCompleted();
    expect(mgr.getRecord(a)).toBeUndefined();
    mgr.dispose();
  });
});

describe('AgentManager background keep-alive', () => {
  it('tracks pending background work and waitForBackground resolves once they finish', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0)); // background
    await flush();
    expect(mgr.hasPendingBackground()).toBe(true);

    let waited = false;
    void mgr.waitForBackground().then(() => { waited = true; });
    await flush();
    expect(waited).toBe(false); // still running

    gates[0].resolve();
    await flush();
    await flush();
    expect(waited).toBe(true);
    expect(mgr.hasPendingBackground()).toBe(false);
    expect(mgr.getRecord(id)!.status).toBe('completed');
    mgr.dispose();
  });

  it('takeCompletedBackgroundResults returns finished background records exactly once', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    mgr.spawn(spec(0));
    await flush();
    expect(mgr.takeCompletedBackgroundResults()).toHaveLength(0); // still running
    gates[0].resolve();
    await flush();
    await flush();
    const first = mgr.takeCompletedBackgroundResults();
    expect(first).toHaveLength(1);
    expect(mgr.takeCompletedBackgroundResults()).toHaveLength(0); // consumed — never re-injected
    mgr.dispose();
  });

  it('emits backgroundTaskStarted on start and backgroundTaskCompleted on finish', async () => {
    const { engine, gates } = makeEngine();
    const msgs: { type: string }[] = [];
    engine.postMessage = (m) => msgs.push(m as { type: string });
    const mgr = new AgentManager(engine, 4);
    mgr.spawn(spec(0));
    await flush();
    expect(msgs.some((m) => m.type === 'backgroundTaskStarted')).toBe(true);
    expect(msgs.some((m) => m.type === 'backgroundTaskCompleted')).toBe(false);
    gates[0].resolve();
    await flush();
    await flush();
    expect(msgs.some((m) => m.type === 'backgroundTaskCompleted')).toBe(true);
    mgr.dispose();
  });

  it('aborting a running background subagent emits exactly one stopped completion (US-009 stopTask)', async () => {
    const { engine, gates } = makeEngine();
    const msgs: { type: string; status?: string }[] = [];
    engine.postMessage = (m) => msgs.push(m as { type: string; status?: string });
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await flush();
    expect(mgr.getRecord(id)!.status).toBe('running');

    // The Background Tasks "stop" button routes stopBackgroundTask → PiSession.stopTask → abort.
    expect(mgr.abort(id)).toBe(true);
    expect(mgr.getRecord(id)!.status).toBe('stopped');

    gates[0].resolve(); // the aborted run settles (real pi: prompt rejects on the abort signal)
    await flush();
    await flush();

    const completions = msgs.filter((m) => m.type === 'backgroundTaskCompleted');
    expect(completions).toHaveLength(1); // exactly one — the handler no longer optimistically posts
    expect(completions[0].status).toBe('stopped');
    mgr.dispose();
  });

  it('foreground spawns are not counted as pending background', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    void mgr.spawnAndWait({ ...spec(0), runInBackground: false });
    await flush();
    expect(mgr.hasPendingBackground()).toBe(false);
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    gates[0]?.resolve();
    await flush();
    mgr.dispose();
  });

  it('hasUnconsumedBackground stays true for an agent that finished mid-turn but was never fetched', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0)); // background
    await flush();
    gates[0].resolve(); // completes during the turn, before agent_end
    await flush();
    await flush();
    expect(mgr.getRecord(id)!.status).toBe('completed');
    // The old gate (hasPendingBackground) is false here — this is exactly the dropped-result bug.
    expect(mgr.hasPendingBackground()).toBe(false);
    // The keep-alive gate must still report work to incorporate.
    expect(mgr.hasUnconsumedBackground()).toBe(true);
    mgr.takeCompletedBackgroundResults(); // parent injects it once
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    mgr.dispose();
  });

  it('hasUnconsumedBackground is false once a result was already fetched via GetSubagentResult', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await flush();
    gates[0].resolve();
    await flush();
    await flush();
    mgr.getRecord(id)!.resultConsumed = true; // GetSubagentResult marks this on read
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    mgr.dispose();
  });
});

describe('AgentManager steer', () => {
  it('reports "failed" (not "steered") when delivery throws', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    (record.session as unknown as { steer: () => Promise<void> }).steer = () => Promise.reject(new Error('mid-shutdown'));
    expect(await mgr.steer(id, 'hello')).toBe('failed');
    mgr.dispose();
  });

  it('reports "steered" on successful delivery', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush();
    expect(await mgr.steer(id, 'hello')).toBe('steered');
    mgr.dispose();
  });

  it('injects the message tagged with the absolute-priority marker', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    const delivered: string[] = [];
    (record.session as unknown as { steer: (m: string) => Promise<void> }).steer = async (m) => { delivered.push(m); };
    expect(await mgr.steer(id, 'focus on tests')).toBe('steered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.startsWith(STEER_INSTRUCTION_PREFIX)).toBe(true);
    expect(delivered[0]).toContain('focus on tests');
    mgr.dispose();
  });

  it('buffers a queued steer already tagged with the priority marker', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0)); // fills the single concurrency slot
    const queued = mgr.spawn(spec(1)); // over the cap → queued
    expect(mgr.getRecord(queued)!.status).toBe('queued');
    expect(await mgr.steer(queued, 'do X')).toBe('queued');
    const buffered = mgr.getRecord(queued)!.pendingSteers!;
    expect(buffered).toHaveLength(1);
    expect(buffered[0]!.startsWith(STEER_INSTRUCTION_PREFIX)).toBe(true);
    expect(buffered[0]).toContain('do X');
    mgr.dispose();
  });

  it('reports "finished" (not "steered") when the run settles while steer() is in flight', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    // Simulate the completion path settling the record during the steer await (steer/finish race).
    (record.session as unknown as { steer: () => Promise<void> }).steer = async () => { record.status = 'completed'; };
    expect(await mgr.steer(id, 'too late')).toBe('finished');
    mgr.dispose();
  });

  it('drops the undelivered steer buffer and parent-awareness note when a queued agent is aborted', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0)); // fills the slot
    const queued = mgr.spawn(spec(1)); // queued
    await mgr.steer(queued, 'do X'); // buffers a pending steer
    const record = mgr.getRecord(queued)!;
    record.userSteers = ['do X']; // PiSession records the parent-awareness note on a queued steer
    expect(mgr.abort(queued)).toBe(true);
    expect(record.status).toBe('stopped');
    expect(record.pendingSteers).toBeUndefined();
    expect(record.userSteers).toBeUndefined();
    mgr.dispose();
  });
});

describe('AgentManager thinkingLevel precedence', () => {
  /** Engine variant that captures each createSession call's options so the test can assert the
   *  thinkingLevel actually passed to session creation. */
  function makeCapturingEngine(): { engine: SubagentEngine; gates: Gate[]; captured: Array<Record<string, unknown>> } {
    const { engine, gates } = makeEngine();
    const captured: Array<Record<string, unknown>> = [];
    engine.createSession = async (opts) => {
      captured.push(opts as unknown as Record<string, unknown>);
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      gates.push({ resolve });
      const session = {
        subscribe: () => () => {},
        prompt: () => promise,
        messages: [],
        getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        getLastAssistantText: () => '',
        setSessionName: () => {},
        setAutoCompactionEnabled: () => {},
        steer: async () => {},
        abort: async () => {},
        dispose: () => {},
        sessionId: 'sid',
      };
      return session as unknown as AgentSession;
    };
    return { engine, gates, captured };
  }

  it('enforceThinking beats a per-spawn spec.thinking', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({ thinkingLevel: 'high', enforceThinking: true });
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), thinking: 'low' });
    await flush();
    expect(captured[0].thinkingLevel).toBe('high');
    gates[0].resolve();
    await flush();
    mgr.dispose();
  });

  it('without enforceThinking, spec.thinking wins over resolved.thinkingLevel', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({ thinkingLevel: 'high' });
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), thinking: 'low' });
    await flush();
    expect(captured[0].thinkingLevel).toBe('low');
    gates[0].resolve();
    await flush();
    mgr.dispose();
  });

  it('passes no thinkingLevel when neither spec.thinking nor resolved.thinkingLevel is set', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({});
    const mgr = new AgentManager(engine, 2);
    mgr.spawn(spec(0));
    await flush();
    expect(captured[0]).not.toHaveProperty('thinkingLevel');
    gates[0].resolve();
    await flush();
    mgr.dispose();
  });
});

describe('AgentManager resolveRunInBackground', () => {
  it('honors an explicit param over the template default, both directions', () => {
    const { engine } = makeEngine();
    engine.registry.register(
      new Map([
        ['bg-default', { name: 'bg-default', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, runInBackground: true }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    // Explicit param wins in both directions.
    expect(mgr.resolveRunInBackground('bg-default', false)).toBe(false);
    expect(mgr.resolveRunInBackground('general-purpose', true)).toBe(true);
    mgr.dispose();
  });

  it('falls back to the template frontmatter default when the param is omitted', () => {
    const { engine } = makeEngine();
    engine.registry.register(
      new Map([
        ['bg-default', { name: 'bg-default', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, runInBackground: true }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    expect(mgr.resolveRunInBackground('bg-default', undefined)).toBe(true); // template default
    expect(mgr.resolveRunInBackground('general-purpose', undefined)).toBe(false); // no default → foreground
    expect(mgr.resolveRunInBackground('does-not-exist', undefined)).toBe(false); // unknown → foreground
    mgr.dispose();
  });
});

describe('AgentManager listActive', () => {
  it('returns only running + queued records with the exact RunningSubagentInfo shape', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    // A background spawn that completes → terminal 'completed', must be excluded.
    const doneId = mgr.spawn(spec(0));
    await flush();
    gates[0].resolve();
    await flush();
    await flush();
    expect(mgr.getRecord(doneId)!.status).toBe('completed');

    // A background spawn that is aborted → terminal 'stopped', must be excluded.
    const stoppedId = mgr.spawn(spec(1));
    await flush();
    expect(mgr.abort(stoppedId)).toBe(true);
    gates[1].resolve(); // let the aborted run settle so its slot frees
    await flush();
    await flush();
    expect(mgr.getRecord(stoppedId)!.status).toBe('stopped');

    // Now build the active set: a background running, a foreground running, and a queued (cap = 2).
    const bgRunningId = mgr.spawn(spec(2)); // background → isBackground true
    const fgRunningId = mgr.spawn({ ...spec(3), runInBackground: false }); // foreground → isBackground false
    const queuedId = mgr.spawn(spec(4)); // over the cap → queued
    await flush();
    expect(mgr.getRecord(bgRunningId)!.status).toBe('running');
    expect(mgr.getRecord(fgRunningId)!.status).toBe('running');
    expect(mgr.getRecord(queuedId)!.status).toBe('queued');

    const active = mgr.listActive();

    // Only the three active records are returned — completed + stopped are excluded.
    expect(active.map((a) => a.id).sort()).toEqual([bgRunningId, fgRunningId, queuedId].sort());

    // Each item has exactly the RunningSubagentInfo keys.
    for (const item of active) {
      expect(Object.keys(item).sort()).toEqual(['agentType', 'description', 'id', 'isBackground', 'status']);
    }

    const byId = new Map(active.map((a) => [a.id, a]));
    // agentType mirrors record.type; description mirrors record.description.
    expect(byId.get(bgRunningId)).toEqual({ id: bgRunningId, agentType: 'general-purpose', description: 'd2', status: 'running', isBackground: true });
    expect(byId.get(fgRunningId)).toEqual({ id: fgRunningId, agentType: 'general-purpose', description: 'd3', status: 'running', isBackground: false });
    expect(byId.get(queuedId)).toEqual({ id: queuedId, agentType: 'general-purpose', description: 'd4', status: 'queued', isBackground: true });

    mgr.dispose();
  });
});
