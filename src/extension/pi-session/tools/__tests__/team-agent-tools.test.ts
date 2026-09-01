import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { PiCodingAgentModule } from '../../pi-loader';
import { MAX_FINGERPRINTED_FILES, TEAM_AGENT_PI_TOOL_NAMES, TEAM_AGENT_SPECS, UNCHANGED_MARKER_PREFIX, buildAllTeamAgentPiTools, buildTeamAgentPiTools, teamAgentPiToolNamesForRole } from '../team-tools';
import { Scratchpad } from '../../../team/scratchpad';
import type { AgentMcpContext, TeamAgent } from '../../../team/types';

type PiTool = {
  name: string;
  description: string;
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
    recordVerification: () => ({ version: 2 }),
    readVerificationLedger: () => '',
    checkMessageDeliverable: () => ({ ok: true }),
    ...over,
  } as AgentMcpContext;
}

function specialistCtx(over: Partial<AgentMcpContext> = {}): AgentMcpContext {
  return leadCtx({ role: 'specialist', agentName: 'Dev', agentId: 'dev-id', ...over });
}

function toolMap(ctx: AgentMcpContext): Map<string, PiTool> {
  const tools = buildTeamAgentPiTools(pi, ctx, process.cwd()) as unknown as PiTool[];
  return new Map(tools.map((t) => [t.name, t]));
}

/**
 * The runtime role guard is defence in depth behind the registration filter, which does not hand a tool
 * to the other role at all, so reaching the guard means building the unfiltered set as the wrong caller.
 */
function guardedTool(name: string, callerRole: 'lead' | 'specialist'): PiTool {
  const ctx = callerRole === 'lead' ? leadCtx() : specialistCtx();
  const tools = buildAllTeamAgentPiTools(pi, ctx, process.cwd()) as unknown as PiTool[];
  return tools.find((t) => t.name === name)!;
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
    const spawn = guardedTool('team_spawn_specialist', 'specialist');
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
    expect(res.content[0]!.text).toMatch(/re-dispatched/);
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
    const redispatch = guardedTool('team_redispatch_specialist', 'specialist');
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
    const flag = guardedTool('team_flag_brief_conflict', 'lead');
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
    const resolve = guardedTool('team_resolve_brief_conflict', 'specialist');
    await expect(resolve.execute('id', { name: 'Dev', resolution: 'ten-plus char resolution' })).rejects.toThrow(/Only the lead/);
  });
});

describe('team_synthesize_result — conflict gate', () => {
  it('blocks explicit synthesis while a brief conflict is open, naming the conflict', async () => {
    const ctx = leadCtx({ getOpenBriefConflicts: () => [{ name: 'Dev', detail: 'async vs sync mismatch' }] });
    const synth = toolMap(ctx).get('team_synthesize_result')!;
    await expect(synth.execute('id', { result: 'done' })).rejects.toThrow(/Unresolved brief conflicts: Dev \(async vs sync mismatch\)/);
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
    expect(res.content[0]!.text).toMatch(/Message sent/);
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
      expect(res.content[0]!.text).toMatch(/Message sent/);
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

/**
 * `team_record_verification` — the shared, fingerprinted verification ledger (RC2). The whole point is
 * that the EXTENSION computes the tree fingerprint: a self-reported one can be wrong or stale, and a
 * wrong fingerprint makes a reused pass unsound, turning evidence back into the bare claim the ledger
 * exists to replace. These tests drive the real tool against real git state in a temp repo.
 */
describe('team_record_verification — extension-computed tree fingerprint', () => {
  function ledgerCtx(over: Partial<AgentMcpContext> = {}): { ctx: AgentMcpContext; entries: string[] } {
    const entries: string[] = [];
    const ctx = specialistCtx({
      recordVerification: (entry: string) => { entries.push(entry); return { version: entries.length + 1 }; },
      readVerificationLedger: () => entries.join('\n'),
      ...over,
    });
    return { ctx, entries };
  }
  function tool(ctx: AgentMcpContext, cwd: string): PiTool {
    const tools = buildTeamAgentPiTools(pi, ctx, cwd) as unknown as PiTool[];
    return tools.find((t) => t.name === 'team_record_verification')!;
  }

  it('is registered for both the lead and a specialist', () => {
    expect(toolMap(leadCtx()).has('team_record_verification')).toBe(true);
    expect(toolMap(specialistCtx()).has('team_record_verification')).toBe(true);
  });

  it('exposes NO fingerprint parameter — the agent cannot supply one', () => {
    const props = (toolMap(specialistCtx()).get('team_record_verification')!.parameters as unknown as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('fingerprint');
    expect(props).not.toHaveProperty('tree');
    expect(Object.keys(props).sort()).toEqual(['command', 'failures', 'result']);
  });

  it('stamps the entry with a real fingerprint that CHANGES when a tracked file is edited', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
    try {
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
      git('init');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'original');
      git('add', '.');
      git('commit', '-m', 'init');

      const { ctx, entries } = ledgerCtx();
      const record = tool(ctx, repo);

      await record.execute('id', { command: 'npx vitest run', result: 'pass' });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'edited after the first run');
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });

      const fingerprints = entries.map((e) => /tree ([0-9a-f]+|unverifiable)/.exec(e)![1]);
      expect(fingerprints).toHaveLength(2);
      expect(fingerprints[0]).toMatch(/^[0-9a-f]{16}$/);
      expect(fingerprints[1]).not.toBe(fingerprints[0]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  /** A throwaway git repo with one committed file, for fingerprint tests that must not touch the dev tree. */
  function tempRepo(): string {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-ledger-')));
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'init');
    return repo;
  }

  /**
   * A throwaway NON-repo directory for tests that assert classification/formatting only. Those need no
   * git state, and pointing them at process.cwd() would fingerprint the developer's entire dirty tree —
   * slow, and hostage to local state.
   */
  function tmpNonRepo(): string {
    return path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-ledger-nogit-'))), 'nope');
  }

  const treesOf = (entries: string[]): string[] => entries.map((e) => /tree ([0-9a-f]+|unverifiable)/.exec(e)![1]!);

  it('changes when a file inside a NEW UNTRACKED DIRECTORY is edited (git collapses those to one line)', async () => {
    // Regression: `git status --porcelain` without -uall reports an untracked directory as a single
    // `?? dir/` line. Hashing that path alone makes the fingerprint blind to every edit inside the
    // directory, so a pass recorded before an edit stays reusable forever — the exact unsoundness the
    // ledger exists to prevent. Caught in live F5 verification, where three runs across an edit all
    // produced an identical fingerprint.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ledger-untracked-'));
    try {
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
      git('init');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base');
      git('add', '.');
      git('commit', '-m', 'init');

      // Every change lives inside a directory that did not exist at HEAD.
      fs.mkdirSync(path.join(repo, 'smoke'));
      fs.writeFileSync(path.join(repo, 'smoke', 'sample.txt'), 'count=1');

      const { ctx, entries } = ledgerCtx();
      const record = tool(ctx, repo);
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });
      fs.writeFileSync(path.join(repo, 'smoke', 'sample.txt'), 'count=2');
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });

      const [first, second] = entries.map((e) => /tree ([0-9a-f]+|unverifiable)/.exec(e)![1]);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails soft in a non-git cwd — records an unverifiable entry instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ledger-nogit-'));
    try {
      const { ctx, entries } = ledgerCtx();
      const res = await tool(ctx, path.join(dir, 'does-not-exist'));
      await expect(res.execute('id', { command: 'npx vitest run', result: 'pass' })).resolves.toBeDefined();
      expect(entries[0]).toContain('tree unverifiable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still tracks content when cwd is a SUBDIRECTORY of the repo (porcelain paths are repo-root relative)', async () => {
    // git reports paths relative to the repository top level, never to the -C directory. Resolving them
    // against cwd would point every path at a nonexistent file in any workspace opened at a subdirectory
    // (monorepo package, nested workspace), the read would fail, the catch would swallow it, and the
    // hash would cover only status lines — identical before and after a real edit.
    const repo = tempRepo();
    try {
      const sub = path.join(repo, 'packages', 'app');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'sample.txt'), 'count=1');

      const { ctx, entries } = ledgerCtx();
      const record = tool(ctx, sub);
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });
      fs.writeFileSync(path.join(sub, 'sample.txt'), 'count=2');
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });

      const [first, second] = treesOf(entries);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still tracks content of paths git would C-quote (non-ASCII, spaces)', async () => {
    // Without -z, porcelain quotes these as "smÃ¶ke.txt"; the raw bytes then name no real file.
    const repo = tempRepo();
    try {
      const weird = path.join(repo, 'smöke file.txt');
      fs.writeFileSync(weird, 'count=1');

      const { ctx, entries } = ledgerCtx();
      const record = tool(ctx, repo);
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });
      fs.writeFileSync(weird, 'count=2');
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });

      const [first, second] = treesOf(entries);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats a rename origin record as part of the rename, not as its own path', async () => {
    const repo = tempRepo();
    try {
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
      git('mv', 'tracked.txt', 'renamed.txt');

      const { ctx, entries } = ledgerCtx();
      const record = tool(ctx, repo);
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });
      fs.writeFileSync(path.join(repo, 'renamed.txt'), 'edited after rename');
      await record.execute('id', { command: 'npx vitest run', result: 'pass' });

      const [first, second] = treesOf(entries);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records unverifiable rather than a silently partial hash when the dirty set exceeds the cap', async () => {
    // A hash that ignores everything past the cap looks exactly as authoritative as a complete one.
    const repo = tempRepo();
    try {
      for (let i = 0; i <= MAX_FINGERPRINTED_FILES; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
      const { ctx, entries } = ledgerCtx();
      await (tool(ctx, repo)).execute('id', { command: 'npx vitest run', result: 'pass' });
      expect(entries[0]).toContain('tree unverifiable');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    // Explicit timeout: the cap is a production constant, so proving it requires materialising more than
    // MAX_FINGERPRINTED_FILES real files, which exceeds the 5s default under parallel suite load.
  }, 60_000);

  it('rejects `failures` on a passing run instead of silently dropping it', async () => {
    const { ctx } = ledgerCtx();
    const record = tool(ctx, tmpNonRepo());
    await expect(record.execute('id', { command: 'npx vitest run', result: 'pass', failures: 'none really' }))
      .rejects.toThrow(/only valid when `result` is "fail"/);
  });

  it('classifies scoped runs conservatively — a name filter is not a full suite', async () => {
    // `scope` is what a peer keys "this run is provably redundant, skip it" on, so mislabelling a
    // filtered run as full-suite lets the next agent skip the real suite on the strength of ten tests.
    const { ctx, entries } = ledgerCtx();
    const record = tool(ctx, tmpNonRepo());
    for (const command of [
      'npx vitest run',
      'npm test',
      'npx vitest run --coverage',
      'npx vitest run src/extension/team',
      'npx vitest run suppression',
      'npx vitest run -t "broadcast storm"',
      'npx vitest run --testNamePattern storm',
      'npx vitest run --project unit',
      'npx vitest run --shard 1/4',
      'npm run test:unit',
    ]) await record.execute('id', { command, result: 'pass' });

    expect(entries.slice(0, 3).every((e) => e.includes('| full-suite |'))).toBe(true);
    expect(entries.slice(3).every((e) => e.includes('| scoped |'))).toBe(true);
  });

  it('echoes only the recent ledger tail, with a count of what it elided', async () => {
    // The whole ledger goes into the tool result, so an uncapped echo re-injects the full history into
    // context on every record.
    const { ctx, entries } = ledgerCtx();
    const record = tool(ctx, tmpNonRepo());
    for (let i = 0; i < 40; i++) await record.execute('id', { command: `npx vitest run ${i}`, result: 'pass' });
    const res = await record.execute('id', { command: 'npx vitest run', result: 'pass' });

    const text = res.content[0]!.text;
    expect(text).toContain('earlier entries');
    expect(text.split('\n').filter((l: string) => l.startsWith('- ['))).toHaveLength(25);
    expect(entries).toHaveLength(41);
  });

  it('records the author, command, result and failure summary, and returns the whole ledger', async () => {
    const { ctx, entries } = ledgerCtx();
    const record = tool(ctx, tmpNonRepo());
    await record.execute('id', { command: 'npx vitest run', result: 'pass' });
    const res = await record.execute('id', { command: 'npx vitest run', result: 'fail', failures: 'team-runner.test.ts > suppression' });

    expect(entries[0]).toContain('Dev');
    expect(entries[0]).toContain('`npx vitest run` → PASS');
    expect(entries[1]).toContain('→ FAIL');
    expect(entries[1]).toContain('failures: team-runner.test.ts > suppression');
    // The tool hands back every entry so a peer can see this tree was already verified.
    expect(res.content[0]!.text).toContain('→ PASS');
    expect(res.content[0]!.text).toContain('→ FAIL');
  });
});

/**
 * The description is the contract the model reads on every request, and the engine now enforces it:
 * an assistant message carrying a `team_standby` call ends the turn (`AgentRunner.startAgent`). These
 * pin the prose to what the hook does, so the two cannot drift back apart.
 */
describe('team_standby description states what the engine does', () => {
  const standbyDescription = (): string => toolMap(specialistCtx()).get('team_standby')!.description;

  it('states that the call ends the turn and parks the agent until peer content arrives', () => {
    const description = standbyDescription();
    expect(description).toContain('Calling this tool ends your turn');
    expect(description).toContain('the last thing you do in that turn');
    expect(description).toContain('until a teammate messages you or a scratchpad notice arrives');
    expect(description).toContain('Standby is the only state in which scratchpad update notifications wake you');
  });

  it('states the queued-message exception, the one case the engine does not stop the turn', () => {
    // Any queued prompt suppresses the stop, so the wording must not narrow it to teammate messages:
    // the runner also enqueues system broadcasts, scratchpad notices, and user notes via the note sink.
    const description = standbyDescription();
    expect(description).toContain('If a message is already queued when your turn ends, you keep running');
    expect(description).not.toContain('If a teammate message is already queued');
  });

  it('promises no session pause of its own and points terminal work at team_report_complete', () => {
    const description = standbyDescription();
    // The old text promised "Your session pauses and automatically resumes", which the tool never did.
    expect(description).not.toContain('Your session pauses');
    expect(description).not.toContain('End your response immediately after calling this tool');
    expect(description).toContain('This is NOT a terminal "my work is done" state');
    expect(description).toContain('Call team_report_complete for that, never team_standby');
  });

  it('leaves team_report_complete as the terminal action and points at the summary', () => {
    const reportComplete = toolMap(specialistCtx()).get('team_report_complete')!.description;
    expect(reportComplete).toContain('This is the MANDATED terminal action');
    expect(reportComplete).toContain('It must be your final call, never team_standby');
    expect(reportComplete).toContain('passing your closing summary in `summary`');
  });

  it('no longer tells the model to end a response the engine already ends', async () => {
    const tools = toolMap(specialistCtx());
    expect(tools.get('team_report_complete')!.description).not.toContain('End your response immediately after calling this tool');
    const standby = await tools.get('team_standby')!.execute('id', {});
    const reported = await tools.get('team_report_complete')!.execute('id', { summary: 'delivered the parser, suite passes' });
    expect(standby.content[0]!.text).toBe('Standby requested, so the turn ends here unless a message is already queued, and new peer content resumes you.');
    expect(reported.content[0]!.text).toBe('Entering awaiting-review. The lead will review your work.');
  });

  it('returns a result that carries the queued-message exception rather than promising standby', async () => {
    // The engine declines to stop the turn while a message is queued, so an unconditional promise here
    // tells the model it is parked while it keeps running.
    const standby = await toolMap(specialistCtx()).get('team_standby')!.execute('id', {});
    const text = standby.content[0]!.text;
    expect(text).toContain('unless a message is already queued');
    expect(text).not.toContain('Entering standby');
  });
});

/**
 * The sign-off the specialist used to have nowhere to put, so it spent a second full-context request on
 * a trailing text message instead.
 */
describe('team_report_complete carries the closing summary', () => {
  const schema = (): TSchema => toolMap(specialistCtx()).get('team_report_complete')!.parameters;

  it('requires a summary, rejecting the old no-argument call', () => {
    expect(Value.Check(schema(), {})).toBe(false);
    expect(Value.Check(schema(), { summary: 'delivered the parser, suite passes' })).toBe(true);
  });

  it('bounds the summary the way the other prose fields in this file are bounded', () => {
    expect(Value.Check(schema(), { summary: 'too short' })).toBe(false);
    expect(Value.Check(schema(), { summary: 'x'.repeat(32_769) })).toBe(false);
  });

  it('hands the summary to the runner unmodified, with the agent name', async () => {
    const calls: Array<[string, string]> = [];
    const ctx = specialistCtx({ reportComplete: (name, summary) => { calls.push([name, summary]); } });
    await toolMap(ctx).get('team_report_complete')!.execute('id', { summary: 'delivered the parser, suite passes' });
    expect(calls).toEqual([['Dev', 'delivered the parser, suite passes']]);
  });
});

/**
 * Every agent used to carry every team tool, so a lead read the specialist-only descriptions on every
 * request and sometimes called one. Registration now follows the same split as the runtime guards.
 */
describe('team tool registration follows the agent role', () => {
  const LEAD_ONLY = ['team_spawn_specialist', 'team_redispatch_specialist', 'team_cancel_specialist', 'team_request_revision', 'team_approve_specialist', 'team_resolve_brief_conflict', 'team_synthesize_result'];
  const SPECIALIST_ONLY = ['team_standby', 'team_report_complete', 'team_flag_brief_conflict'];
  const BOTH = ['team_send_message', 'team_read_messages', 'team_read_scratchpad', 'team_write_scratchpad', 'team_get_status', 'team_record_verification'];

  it('gives the lead its own tools and the shared ones, and no specialist-only tool', () => {
    expect([...toolMap(leadCtx()).keys()].sort()).toEqual([...LEAD_ONLY, ...BOTH].sort());
  });

  it('gives a specialist its own tools and the shared ones, and no lead-only tool', () => {
    expect([...toolMap(specialistCtx()).keys()].sort()).toEqual([...SPECIALIST_ONLY, ...BOTH].sort());
  });

  it('exports the same names for a role as it registers tools, so a spawn cannot advertise a tool the agent lacks', () => {
    expect([...teamAgentPiToolNamesForRole('lead')].sort()).toEqual([...toolMap(leadCtx()).keys()].sort());
    expect([...teamAgentPiToolNamesForRole('specialist')].sort()).toEqual([...toolMap(specialistCtx()).keys()].sort());
  });

  it('keeps TEAM_AGENT_PI_TOOL_NAMES the union, which is what the gateable set asks for', () => {
    expect([...TEAM_AGENT_PI_TOOL_NAMES].sort()).toEqual([...LEAD_ONLY, ...SPECIALIST_ONLY, ...BOTH].sort());
  });

  it('throws when a built tool has no TEAM_AGENT_ENTRIES entry, rather than dropping it for both roles', () => {
    // A name the access table does not carry is filtered out for every role, so without the guard the
    // omission reaches production with no error, no log and no failing test.
    const renaming = {
      defineTool: (tool: { name: string }) => ({ ...tool, name: tool.name === 'team_standby' ? 'team_unlisted' : tool.name }),
    } as unknown as PiCodingAgentModule;
    expect(() => buildAllTeamAgentPiTools(renaming, specialistCtx(), process.cwd())).toThrow(/team_unlisted/);
    expect(() => buildAllTeamAgentPiTools(renaming, specialistCtx(), process.cwd())).toThrow(/TEAM_AGENT_ENTRIES/);
    expect(() => buildAllTeamAgentPiTools(pi, specialistCtx(), process.cwd())).not.toThrow();
  });

  it('hands back a frozen name list, which every caller shares', () => {
    const names = teamAgentPiToolNamesForRole('lead');
    expect(Object.isFrozen(names)).toBe(true);
    expect(teamAgentPiToolNamesForRole('lead')).toBe(names);
    expect(Object.isFrozen(teamAgentPiToolNamesForRole('specialist'))).toBe(true);
  });

  it('keeps the runtime guard behind the filter: the wrong role still gets thrown at', async () => {
    await expect(guardedTool('team_standby', 'lead').execute('id', {})).rejects.toThrow(/Lead agents do not use standby/);
    await expect(guardedTool('team_report_complete', 'lead').execute('id', { summary: 'delivered the parser, suite passes' }))
      .rejects.toThrow(/Lead agents do not report complete/);
    await expect(guardedTool('team_synthesize_result', 'specialist').execute('id', { result: 'done' })).rejects.toThrow(/Only the lead/);
  });
});

/** The repo prose rule, over every string this file puts in front of a model: descriptions, parameter descriptions and returned text. */
describe('team tools carry no em dash', () => {
  it('has none in any built description or parameter, nor anywhere in the team-tools source', () => {
    const tools = [...toolMap(leadCtx()).values(), ...toolMap(specialistCtx()).values()];
    const offenders = tools.filter((t) => (t.description + JSON.stringify(t.parameters)).includes('\u2014'));
    expect(offenders.map((t) => t.name)).toEqual([]);
    // Returned and thrown text is only reachable by executing every branch, so the source is the cover.
    expect(fs.readFileSync(path.join(__dirname, '..', 'team-tools.ts'), 'utf8')).not.toContain('\u2014');
  });
});

/**
 * team_read_scratchpad withholds only content the reader provably already holds: a section whose current
 * version is at or below the reader's recorded read version comes back as a marker instead of its body.
 */
describe('team_read_scratchpad returns a marker for content the reader already holds', () => {
  const MARKER_HEAD = UNCHANGED_MARKER_PREFIX;

  type ReadEntry = { section: string; content: string; author: string; version: number };

  function readTool(scratchpad: Scratchpad, agentName = 'Dev'): PiTool {
    return toolMap(specialistCtx({ agentName, scratchpad })).get('team_read_scratchpad')!;
  }

  async function readText(tool: PiTool, section?: string): Promise<string> {
    const res = await tool.execute('id', section === undefined ? {} : { section });
    return res.content[0]!.text;
  }

  async function readOne(tool: PiTool, section: string): Promise<ReadEntry> {
    return JSON.parse(await readText(tool, section)) as ReadEntry;
  }

  async function readAll(tool: PiTool): Promise<ReadEntry[]> {
    return JSON.parse(await readText(tool)) as ReadEntry[];
  }

  function marker(version: number): string {
    return `${UNCHANGED_MARKER_PREFIX} ${version}). Content withheld to save context. This section is current, it is not empty and it is not missing.`;
  }

  it('returns full content the first time a reader sees a section', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'the whole contract body', 'Lead');

    const entry = await readOne(readTool(scratchpad), 'contract');

    expect(entry).toEqual({ section: 'contract', content: 'the whole contract body', author: 'Lead', version: 1 });
  });

  it('returns the marker, naming the version, on a second read of an unchanged section', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'the whole contract body', 'Lead');
    const tool = readTool(scratchpad);

    await readOne(tool, 'contract');
    const second = await readOne(tool, 'contract');

    expect(second.content).toBe(marker(1));
    expect(second.content).toContain('(version 1)');
    expect(second.content).not.toContain('the whole contract body');
    // The remaining fields still describe the live section, so the reader can tell what it is holding.
    expect(second).toMatchObject({ section: 'contract', author: 'Lead', version: 1 });
  });

  it('returns full content again once a peer writes a new version', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'v1 body', 'Lead');
    const tool = readTool(scratchpad);

    await readOne(tool, 'contract');
    expect((await readOne(tool, 'contract')).content).toBe(marker(1));
    scratchpad.set('contract', 'v2 body', 'Lead');

    const third = await readOne(tool, 'contract');
    expect(third.content).toBe('v2 body');
    expect(third.version).toBe(2);
    expect((await readOne(tool, 'contract')).content).toBe(marker(2));
  });

  it('leaves the reader recorded at the current version after a marker return', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'v1 body', 'Lead');
    const tool = readTool(scratchpad);

    await readOne(tool, 'contract');
    expect(scratchpad.getReadVersion('Dev', 'contract')).toBe(1);
    await readOne(tool, 'contract');

    expect(scratchpad.getReadVersion('Dev', 'contract')).toBe(1);
    expect(scratchpad.getStaleSectionsFor('Dev', 'Lead')).toEqual([]);
  });

  it('returns full content again to a reader whose read state was cleared for a re-run', async () => {
    // A re-dispatched specialist holds none of what its previous attempt read, so the marker would
    // withhold the brief from a session that never saw it.
    const scratchpad = new Scratchpad();
    scratchpad.set('mission-brief', 'the whole brief', 'Lead');
    const tool = readTool(scratchpad);

    await readOne(tool, 'mission-brief');
    expect((await readOne(tool, 'mission-brief')).content).toBe(marker(1));
    scratchpad.clearReader('Dev');

    expect((await readOne(tool, 'mission-brief')).content).toBe('the whole brief');
  });

  it('tracks each reader separately, so one agent reading does not blind another', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'v1 body', 'Lead');

    await readOne(readTool(scratchpad, 'Dev'), 'contract');
    const other = await readOne(readTool(scratchpad, 'Qa'), 'contract');

    expect(other.content).toBe('v1 body');
  });

  it('mixes full sections and markers in one all-sections response, keeping the array shape', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'contract body', 'Lead');
    const tool = readTool(scratchpad);
    await readAll(tool);
    scratchpad.set('notes', 'notes body', 'Lead');
    scratchpad.set('contract', 'contract body v2', 'Lead');
    scratchpad.set('frozen', 'frozen body', 'Lead');
    await readOne(tool, 'frozen');

    const all = await readAll(tool);

    expect(all).toHaveLength(3);
    expect(all.map((e) => e.section)).toEqual(['contract', 'notes', 'frozen']);
    for (const entry of all) {
      expect(Object.keys(entry).sort()).toEqual(['author', 'content', 'section', 'version']);
    }
    expect(all[0]!.content).toBe('contract body v2');
    expect(all[1]!.content).toBe('notes body');
    expect(all[2]!.content).toBe(marker(1));
  });

  it('marks every section read even when some came back as markers', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'contract body', 'Lead');
    scratchpad.set('notes', 'notes body', 'Lead');
    const tool = readTool(scratchpad);

    await readAll(tool);
    await readAll(tool);

    expect(scratchpad.getReadVersion('Dev', 'contract')).toBe(1);
    expect(scratchpad.getReadVersion('Dev', 'notes')).toBe(1);
  });

  it('leaves the not-found and empty paths byte identical', async () => {
    const scratchpad = new Scratchpad();
    const tool = readTool(scratchpad);

    expect(await readText(tool)).toBe('Scratchpad is empty.');
    expect(await readText(tool, 'missing')).toBe('Section "missing" not found.');
    // Neither path returns a section, so neither counts as a marker hit or a full return.
    expect(scratchpad.getReadStats('Dev')).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  it('returns the verification ledger in full again after an append bumps its version', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.seedAppendOnly('verification');
    const tool = readTool(scratchpad);

    await readOne(tool, 'verification');
    expect((await readOne(tool, 'verification')).content).toBe(marker(1));
    scratchpad.appendTo('verification', '- [abc123] Lead `npm run test` PASS');

    const after = await readOne(tool, 'verification');
    expect(after.version).toBe(2);
    expect(after.content).toBe('- [abc123] Lead `npm run test` PASS');
  });

  it('counts one outcome per section returned, not one per call', async () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('contract', 'contract body', 'Lead');
    scratchpad.set('notes', 'notes body', 'Lead');
    const tool = readTool(scratchpad);

    await readAll(tool);
    expect(scratchpad.getReadStats('Dev')).toEqual({ markerHits: 0, fullReturns: 2 });

    scratchpad.set('notes', 'notes body v2', 'Lead');
    await readAll(tool);
    expect(scratchpad.getReadStats('Dev')).toEqual({ markerHits: 1, fullReturns: 3 });

    await readOne(tool, 'contract');
    expect(scratchpad.getReadStats('Dev')).toEqual({ markerHits: 2, fullReturns: 3 });
    expect(scratchpad.getReadStats()).toEqual({ markerHits: 2, fullReturns: 3 });
    expect(scratchpad.getReadStats('Nobody')).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  /** A model that meets an unannounced marker can read it as "the section vanished" and re-read in a loop. */
  describe('the tool description warns the model about the marker', () => {
    const description = (): string => readTool(new Scratchpad()).description;

    it('states that a marker can arrive instead of content and what it means', () => {
      expect(description()).toContain(MARKER_HEAD);
      expect(description()).toContain('is current and is not empty');
      expect(description()).toContain('already earlier in your context');
    });

    it('quotes the marker the tool actually returns, so the two cannot describe different shapes', async () => {
      const scratchpad = new Scratchpad();
      scratchpad.set('contract', 'the whole contract body', 'Lead');
      const tool = readTool(scratchpad);
      await readOne(tool, 'contract');

      const returned = (await readOne(tool, 'contract')).content;
      const quoted = tool.description.match(/beginning "([^"]+)"/)![1]!;

      expect(returned.startsWith(quoted.replace(' N)', ''))).toBe(true);
    });

    it('tells the model that re-reading a marked section gains it nothing', () => {
      expect(description()).toContain('Re-reading a marked section returns the same marker and gains you nothing');
    });

    it('keeps the marker distinct from the not-found and the empty reply', () => {
      expect(description()).toContain('not found.');
      expect(description()).toContain('Scratchpad is empty.');
    });

    it('carries no em dash (repo prose rule)', () => {
      expect(description()).not.toContain('\u2014');
    });

    it('says the same thing in the short catalog blurb', () => {
      const spec = TEAM_AGENT_SPECS.find((s) => s.name === 'team_read_scratchpad')!;
      expect(spec.description).toContain('unchanged marker');
      expect(spec.description).not.toContain('\u2014');
    });
  });
});
