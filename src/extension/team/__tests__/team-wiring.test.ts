import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TeamRunner, VERIFICATION_SECTION, leadShouldDeliverMessage } from '../team-runner';
import { AgentRunner } from '../agent-runner';
import { Scratchpad } from '../scratchpad';
import { MessageBus } from '../message-bus';
import { FakeSession } from './fake-session';
import type { TeamAgent, TeamConfig, TeamRole } from '../types';
import { type NestedMcpToolset } from '../../pi-session/tools/mcp-tools';
import { teamAgentToolset, TEAM_BASE_TOOL_NAMES, TEAM_MCP_NAMES } from './team-mcp-fixture';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

/**
 * The runner<->agent SEAM suite. Every other team test stubs one side: `team-runner.test.ts` injects a
 * fake `agentRunner` (so the real bus subscription and re-prompt loop never run) and
 * `agent-runner.test.ts` only ever sends DIRECTED messages (so a broadcast delivery decision is never
 * exercised). With both sides stubbed nothing observed what an agent's session actually receives, which
 * is exactly how a scratchpad-notice re-prompt storm and a duplicate `[REVIEW ROUND READY]` both shipped.
 *
 * These tests wire the REAL TeamRunner to the REAL AgentRunner and fake only the pi session, then assert
 * on `FakeSession.prompts` — the prompts an agent is actually charged for.
 */

function makeAgent(name: string, role: TeamAgent['role']): TeamAgent {
  return {
    agentId: `id-${name}`, teamId: 'team-1', name, role, attempt: 0, specialization: '',
    status: 'pending', model: 'test', profileId: null, startTime: null, endTime: null,
    toolCallCount: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, costUsd: 0,
    carriedUsage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    dollarBilled: true, finalResponse: null, error: null, logFilePath: null,
  };
}

interface Wiring {
  runner: TeamRunner;
  scratchpad: Scratchpad;
  messageBus: MessageBus;
  /** Queue a fake pi session for the next agent the runner spawns (consumed in spawn order). */
  useSession: (session: FakeSession) => void;
  teamEntries: Array<Record<string, unknown>>;
  webviewMessages: ExtensionToWebviewMessage[];
  /** Everything that reached `createSession`, in spawn order — lead first. */
  sessionOpts: Array<Record<string, unknown>>;
  /** The snapshot each `buildAgentToolset` returned, and the one each factory was handed. */
  toolsetSnapshots: NestedMcpToolset[];
  factoryMcpSnapshots: NestedMcpToolset[];
  /** Flush the microtask queue so the runner's deferred sends and prompt loop settle. */
  settle: () => Promise<void>;
}

/**
 * A TeamRunner with its real AgentRunner, real MessageBus, real Scratchpad and real subscriber fan-out
 * (installSubscribers), backed by fake pi sessions. `run()` is not called — it would need a live engine
 * and would block — so the collaborators it builds are injected and its subscriber wiring invoked
 * directly, keeping every delivery/persistence/emission path under test identical to production.
 */
function makeWiring(specialistNames: string[], overrides?: { cwd?: string }): Wiring {
  const teamEntries: Array<Record<string, unknown>> = [];
  const webviewMessages: ExtensionToWebviewMessage[] = [];
  const pendingSessions: FakeSession[] = [];
  const sessionOpts: Array<Record<string, unknown>> = [];
  const toolsetSnapshots: NestedMcpToolset[] = [];
  const factoryMcpSnapshots: NestedMcpToolset[] = [];

  const config = {
    teamId: 'team-1',
    title: 'wire',
    brief: 'the authoritative spec',
    cwd: overrides?.cwd ?? '/cwd',
    persistenceSessionId: 'sess',
    permissionMode: 'default' as const,
    agents: [
      { name: 'Lead', role: 'lead' as const },
      ...specialistNames.map((n) => ({ name: n, role: 'specialist' as const })),
    ],
    // Distinct per role, because that is the case the panel-level flag gets wrong: a specialist can run
    // a metered model inside a flat-subscription panel.
    resolveRoleModel: (role: TeamRole) => ({
      modelLabel: role === 'lead' ? 'lead-model' : 'spec-model',
      dollarBilled: role !== 'lead',
    }),
    engine: {
      // Each spawn takes the next session the test queued via `useSession`, so the REAL AgentRunner
      // drives a real prompt loop against it.
      // Recorded, not discarded: this harness drives the REAL `run()`, so it is the only place the
      // LEAD spawn's own `createSession` closure is ever executed. Dropping the options here is what
      // left the lead half of the one-call/same-snapshot invariant with no coverage at all.
      createSession: async (opts: Record<string, unknown>) => {
        sessionOpts.push(opts);
        const session = pendingSessions.shift();
        if (!session) throw new Error('queue a FakeSession with useSession() before spawning');
        return session as never;
      },
      forgetSession: () => undefined,
      // The REAL `TeamEngine` shape: ONE call per spawn returning names + customTools + the frozen MCP
      // snapshot, and `buildExtensionFactory` receiving that SAME snapshot as its third argument. The
      // snapshot is NON-EMPTY and built by the real builder — see `team-mcp-fixture.ts` for why an
      // empty one made every spawn-site mutation unobservable.
      buildAgentToolset: () => {
        const { toolNames, customTools, mcp } = teamAgentToolset();
        toolsetSnapshots.push(mcp);
        return { toolNames, customTools, mcp };
      },
      buildExtensionFactory: (_agentName: string, _agentId: string, mcp: NestedMcpToolset) => {
        factoryMcpSnapshots.push(mcp);
        return (() => undefined) as never;
      },
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, (m) => webviewMessages.push(m));
  const target = runner as unknown as Record<string, unknown>;
  const messageBus = new MessageBus('team-1');
  const scratchpad = new Scratchpad();
  target['messageBus'] = messageBus;
  target['scratchpad'] = scratchpad;
  target['persistence'] = {
    initAgentFile: async () => undefined,
    appendAgentEntry: () => undefined,
    appendTeamEntry: (e: Record<string, unknown>) => { teamEntries.push(e); },
    flush: async () => undefined,
  };

  const agentMap = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) agentMap.set(spec.name, makeAgent(spec.name, spec.role));

  // The REAL subscriber fan-out: persistence + webview emission + the scratchpad-notice broadcast.
  (runner as unknown as { installSubscribers: () => void }).installSubscribers();

  return {
    runner, scratchpad, messageBus, teamEntries, webviewMessages, sessionOpts, toolsetSnapshots, factoryMcpSnapshots,
    useSession: (session) => { pendingSessions.push(session); },
    settle: async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); },
  };
}

/**
 * Spawn a specialist through the REAL `startSpecialist` path (so it gets the real keepAlive /
 * shouldDeliverMessage / onTurnEnd closures), backed by a FakeSession, driven by the REAL AgentRunner.
 */
function startSpecialist(w: Wiring, name: string): FakeSession {
  const session = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
  w.useSession(session);
  w.runner.startSpecialist(name, `task for ${name} that is descriptive enough`);
  return session;
}

/** Prompts an agent's session received, excluding its opening task. */
function deliveredPrompts(session: FakeSession): string[] {
  return session.prompts.slice(1);
}

const NOTICE = '[Scratchpad update]';

/** Scratchpad-notice prompts an agent was actually charged for. */
function noticePrompts(session: FakeSession): string[] {
  return deliveredPrompts(session).filter((p) => p.includes(NOTICE));
}

/**
 * Prove an ABSENCE without depending on how many microtasks delivery happens to take today.
 *
 * A bare `await settle()` makes every negative assertion hostage to a tick count: add one await hop to
 * the delivery path and `expect(noticePrompts(b)).toEqual([])` keeps passing while the storm is back.
 * Instead, send a direct control message AFTER the write under test and block until it actually lands.
 * Bus delivery is FIFO, so once the later message has arrived, an earlier notice that never arrived was
 * filtered rather than merely slow.
 */
async function drainPastControl(w: Wiring, session: FakeSession, name: string): Promise<void> {
  const expected = session.prompts.length + 1;
  w.messageBus.send('control', name, CONTROL_MESSAGE);
  await session.whenPrompted(expected);
  await w.settle();
}

const CONTROL_MESSAGE = 'control probe — delivery has flushed to here';

/** Append to the ledger through the agent's REAL MCP context hook. */
function recordVerificationAs(w: Wiring, name: string, entry: string): { version: number } {
  return (w.runner as unknown as {
    buildSpecialistContext: (id: string, scope: string, name: string) => { recordVerification: (e: string) => { version: number } };
  }).buildSpecialistContext(`id-${name}`, `id-${name}#0`, name).recordVerification(entry);
}

/** Notice prompts an agent was charged for, asserted only after a known-delivered control message. */
async function noticePromptsAfterControl(w: Wiring, session: FakeSession, name: string): Promise<string[]> {
  await drainPastControl(w, session, name);
  return noticePrompts(session);
}

describe('team wiring — a scratchpad notice re-prompts only an agent that is waiting', () => {
  it('does NOT prompt a running specialist when a peer writes the scratchpad', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();

    w.scratchpad.set('a-findings', 'A wrote this while B was working', 'A');
    await w.settle();

    expect(await noticePromptsAfterControl(w, b, 'B')).toEqual([]);
  });

  it('wakes a standby specialist exactly once on a peer write', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();

    w.runner.enterStandby('B');
    await w.settle();

    w.scratchpad.set('a-findings', 'A posted findings', 'A');
    await w.settle();

    const delivered = noticePrompts(b);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('"a-findings" updated by A');
  });

  it('never notifies an agent about its own write', async () => {
    const w = makeWiring(['A']);
    const a = startSpecialist(w, 'A');
    await w.settle();
    w.runner.enterStandby('A');
    await w.settle();

    w.scratchpad.set('a-findings', 'my own write', 'A');
    await w.settle();

    expect(await noticePromptsAfterControl(w, a, 'A')).toEqual([]);
  });

  it('still delivers a DIRECT message whose text mimics the notice prefix (the filter reads kind, not content)', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();

    w.messageBus.send('A', 'B', `${NOTICE} "spoofed" updated by A (v9) — please look`);
    await w.settle();

    expect(deliveredPrompts(b).some((p) => p.includes('spoofed'))).toBe(true);
  });

  it('still delivers a peer BROADCAST that is not a scratchpad notice (agent-failure reaches everyone)', async () => {
    const w = makeWiring(['A', 'B']);
    const a = startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();

    w.messageBus.broadcast('system', 'Agent "C" failed: boom');
    await w.settle();

    expect(deliveredPrompts(a).some((p) => p.includes('failed: boom'))).toBe(true);
    expect(deliveredPrompts(b).some((p) => p.includes('failed: boom'))).toBe(true);
  });

  it('still delivers the ownership-rejection broadcast to every agent', async () => {
    const w = makeWiring(['A', 'B']);
    const a = startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();

    w.scratchpad.set('shared', 'from A', 'A');
    expect(() => w.scratchpad.set('shared', 'hijack by B', 'B')).toThrow();
    await w.settle();

    expect(deliveredPrompts(a).some((p) => p.includes('attempted to overwrite'))).toBe(true);
    expect(deliveredPrompts(b).some((p) => p.includes('attempted to overwrite'))).toBe(true);
  });
});

describe('team wiring — persistence, timeline and inbox are unchanged by the delivery filter', () => {
  it('produces exactly one scratchpad-update entry, one agent-message entry, one teamScratchpadUpdate and one teamMessage per write', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    startSpecialist(w, 'B');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    await w.settle();

    const scratchpadEntries = w.teamEntries.filter((e) => e['type'] === 'scratchpad-update');
    const noticeEntries = w.teamEntries.filter(
      (e) => e['type'] === 'agent-message' && String(e['content']).includes(NOTICE),
    );
    const scratchpadEmits = w.webviewMessages.filter((m) => m.type === 'teamScratchpadUpdate');
    const messageEmits = w.webviewMessages.filter(
      (m) => m.type === 'teamMessage' && m.message.content.includes(NOTICE),
    );

    expect(scratchpadEntries).toHaveLength(1);
    expect(noticeEntries).toHaveLength(1);
    expect(scratchpadEmits).toHaveLength(1);
    expect(messageEmits).toHaveLength(1);
  });

  it('keeps the notice in every other agent\'s inbox even though it was not delivered as a prompt', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    startSpecialist(w, 'B');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    await w.settle();

    expect(w.messageBus.getInbox('B').filter((m) => m.content.includes(NOTICE))).toHaveLength(1);
    expect(w.messageBus.getInbox('Lead').filter((m) => m.content.includes(NOTICE))).toHaveLength(1);
  });

  it('never leaks the `kind` discriminator into the persisted entry or the webview payload', async () => {
    const w = makeWiring(['A']);
    startSpecialist(w, 'A');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    await w.settle();

    const persisted = w.teamEntries.find(
      (e) => e['type'] === 'agent-message' && String(e['content']).includes(NOTICE),
    )!;
    expect(Object.keys(persisted).sort()).toEqual(
      ['content', 'from', 'messageId', 'teamId', 'timestamp', 'to', 'type'].sort(),
    );
    const emitted = w.webviewMessages.find(
      (m): m is Extract<ExtensionToWebviewMessage, { type: 'teamMessage' }> =>
        m.type === 'teamMessage' && m.message.content.includes(NOTICE),
    )!;
    expect(Object.keys(emitted.message).sort()).toEqual(
      ['content', 'messageId', 'recipientAgentId', 'recipientName', 'senderAgentId', 'senderName', 'timestamp'].sort(),
    );
  });
});

describe('team wiring — the lead is never re-prompted with an identical [REVIEW ROUND READY]', () => {
  /** Drive the lead's real AgentRunConfig through the REAL AgentRunner against a FakeSession. */
  async function startLead(w: Wiring): Promise<FakeSession> {
    const session = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const lead = (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get('Lead')!;
    lead.status = 'running';
    void new AgentRunner().startAgent({
      agentId: lead.agentId,
      name: 'Lead',
      role: 'lead',
      specialization: 'begin your mission',
      createSession: async () => session as never,
      forgetSession: () => undefined,
      abortSignal: new AbortController().signal,
      messageBus: w.messageBus,
      bindNoteDelivery: () => () => undefined,
      onMessage: () => undefined,
      teamId: 'team-1',
      persistence: { appendAgentEntry: () => undefined, appendTeamEntry: () => undefined, flush: async () => undefined },
      keepAlive: () => true,
      // The REAL exported predicate, not a copy: a hand-rolled duplicate would keep passing after the
      // production filter was loosened.
      shouldDeliverMessage: leadShouldDeliverMessage,
    });
    await w.settle();
    return session;
  }

  it('delivers ONE message for two notifications that render identical text', async () => {
    const w = makeWiring(['A']);
    const leadSession = await startLead(w);
    const a = startSpecialist(w, 'A');
    await w.settle();

    w.runner.reportComplete('A', 'sign-off from A');
    const notify = (): void =>
      (w.runner as unknown as { notifyLeadIfReviewRoundReady: () => void }).notifyLeadIfReviewRoundReady();

    a.emit({ type: 'turn_end' });
    (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get('A')!.status = 'awaiting-review';
    notify();
    notify();
    await w.settle();

    const rrr = leadSession.prompts.filter((p) => p.includes('[REVIEW ROUND READY]'));
    expect(rrr).toHaveLength(1);
  });

  it('re-enables notification once the rendered text changes (a lead read flips UNREAD → up to date)', async () => {
    const w = makeWiring(['A']);
    const leadSession = await startLead(w);
    startSpecialist(w, 'A');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    w.runner.reportComplete('A', 'sign-off from A');
    (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get('A')!.status = 'awaiting-review';
    const notify = (): void =>
      (w.runner as unknown as { notifyLeadIfReviewRoundReady: () => void }).notifyLeadIfReviewRoundReady();

    notify();
    notify();
    await w.settle();
    expect(leadSession.prompts.filter((p) => p.includes('UNREAD'))).toHaveLength(1);

    // The lead reads the section: the notification now renders "up to date" → different text → sent again.
    w.scratchpad.markRead('Lead', 'a-findings');
    notify();
    await w.settle();

    expect(leadSession.prompts.filter((p) => p.includes('[REVIEW ROUND READY]'))).toHaveLength(2);
    expect(leadSession.prompts.some((p) => p.includes('up to date'))).toBe(true);
  });

  it('the lead is never prompted with a scratchpad notice', async () => {
    const w = makeWiring(['A']);
    const leadSession = await startLead(w);
    startSpecialist(w, 'A');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    await w.settle();
    await drainPastControl(w, leadSession, 'Lead');

    expect(leadSession.prompts.filter((p) => p.includes(NOTICE))).toEqual([]);
  });

  it('nudgeLeadOnOpenReviewRound still re-fires identical text (suppression must not reach the stall nudge)', async () => {
    const w = makeWiring(['A']);
    const leadSession = await startLead(w);
    startSpecialist(w, 'A');
    await w.settle();

    w.runner.reportComplete('A', 'sign-off from A');
    (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get('A')!.status = 'awaiting-review';
    const nudge = (): void =>
      (w.runner as unknown as { nudgeLeadOnOpenReviewRound: (n: string) => void }).nudgeLeadOnOpenReviewRound('Lead');

    nudge();
    await w.settle();
    nudge();
    await w.settle();

    expect(leadSession.prompts.filter((p) => p.includes('[REVIEW ROUND READY]'))).toHaveLength(2);
    expect((w.runner as unknown as { leadReviewStalls: number }).leadReviewStalls).toBe(2);
  });
});

/**
 * RC2 — the shared verification ledger. It exists because an agent had no way to learn that a peer had
 * already verified this exact tree state, so re-running the full suite was its only way to be sure
 * (43 full-suite runs across one session). Seeded at team start, appendable by every agent, and
 * streamed through the same subscriber fan-out as any other scratchpad mutation.
 */
describe('team wiring — the verification ledger', () => {
  function seedLedger(w: Wiring): void {
    w.scratchpad.seedAppendOnly(VERIFICATION_SECTION);
  }

  it('is appendable by any agent through its real MCP context hook', async () => {
    const w = makeWiring(['A', 'B']);
    seedLedger(w);
    startSpecialist(w, 'A');
    startSpecialist(w, 'B');
    await w.settle();

    const ctxA = (w.runner as unknown as { buildSpecialistContext: (id: string, scope: string, name: string) => { recordVerification: (e: string) => { version: number }; readVerificationLedger: () => string } })
      .buildSpecialistContext('id-A', 'id-A#0', 'A');
    const ctxB = (w.runner as unknown as { buildSpecialistContext: (id: string, scope: string, name: string) => { recordVerification: (e: string) => { version: number }; readVerificationLedger: () => string } })
      .buildSpecialistContext('id-B', 'id-B#0', 'B');

    ctxA.recordVerification('- A | tree abc | full-suite | PASS');
    ctxB.recordVerification('- B | tree abc | full-suite | PASS');

    expect(ctxA.readVerificationLedger()).toBe('- A | tree abc | full-suite | PASS\n- B | tree abc | full-suite | PASS');
  });

  it('persists and emits every append through the normal scratchpad fan-out', async () => {
    const w = makeWiring(['A']);
    seedLedger(w);
    startSpecialist(w, 'A');
    await w.settle();
    const before = w.teamEntries.filter((e) => e['type'] === 'scratchpad-update').length;

    (w.runner as unknown as { buildSpecialistContext: (id: string, scope: string, name: string) => { recordVerification: (e: string) => { version: number } } })
      .buildSpecialistContext('id-A', 'id-A#0', 'A')
      .recordVerification('- A | tree abc | full-suite | PASS');
    await w.settle();

    const entries = w.teamEntries.filter((e) => e['type'] === 'scratchpad-update' && e['section'] === VERIFICATION_SECTION);
    expect(w.teamEntries.filter((e) => e['type'] === 'scratchpad-update').length).toBe(before + 1);
    expect(entries.at(-1)!['content']).toContain('tree abc');
    expect(w.webviewMessages.filter((m) => m.type === 'teamScratchpadUpdate').length).toBeGreaterThan(0);
  });

  it('re-prompts NOBODY on a ledger append — not even a standby peer', async () => {
    // The ledger is a pull surface: `team_record_verification` returns it, and the prompts tell agents
    // to read it before a run. A peer's test run cannot advance an agent parked on someone's findings,
    // so delivering it would re-prompt a whole conversation to no effect — the amplification RC1 removed.
    const w = makeWiring(['A', 'B']);
    seedLedger(w);
    startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();
    w.runner.enterStandby('B');
    await w.settle();

    recordVerificationAs(w, 'A', '- A | tree abc | full-suite | PASS');
    await w.settle();

    expect(await noticePromptsAfterControl(w, b, 'B')).toEqual([]);
  });

  it('still persists, emits and inboxes a ledger append that reached no prompt', async () => {
    const w = makeWiring(['A', 'B']);
    seedLedger(w);
    startSpecialist(w, 'A');
    startSpecialist(w, 'B');
    await w.settle();

    recordVerificationAs(w, 'A', '- A | tree abc | full-suite | PASS');
    await w.settle();

    // v1 is the seed; the append is v2. Both fan out to persistence and the timeline — only DELIVERY
    // is suppressed, so the audit trail is identical to any other scratchpad write.
    const persisted = w.teamEntries.filter((e) => e['type'] === 'scratchpad-update' && e['section'] === VERIFICATION_SECTION);
    expect(persisted.at(-1)!['version']).toBe(2);
    expect(persisted.at(-1)!['content']).toContain('tree abc');
    const notices = w.teamEntries.filter((e) => e['type'] === 'agent-message' && String(e['content']).includes(VERIFICATION_SECTION));
    expect(notices).toHaveLength(2);
    // Attributed to `system`, the section's owner — a shared ledger has no single author, and the
    // recording agent is named inside the entry text it supplied.
    expect(w.messageBus.getInbox('B').filter((m) => m.content.includes(VERIFICATION_SECTION))).toHaveLength(2);
  });

  it('a peer scratchpad write still wakes standby (the ledger rule did not over-reach)', async () => {
    const w = makeWiring(['A', 'B']);
    seedLedger(w);
    startSpecialist(w, 'A');
    const b = startSpecialist(w, 'B');
    await w.settle();
    w.runner.enterStandby('B');
    await w.settle();

    w.scratchpad.set('a-findings', 'body', 'A');
    await w.settle();

    expect(noticePrompts(b)).toHaveLength(1);
  });
});

describe('team wiring — the ledger is seeded on the REAL startup path', () => {
  it('run() seeds the verification section as append-only before any agent records', async () => {
    // Every other ledger test hand-calls seedAppendOnly, so deleting the seed from run() would leave
    // them all green while the first agent call throws "not an append-only section" at runtime. This
    // drives the real run() (which builds its OWN Scratchpad and persistence) against a temp cwd.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-seed-'));
    const leadSession = new FakeSession({ onPrompt: (_t, sess) => sess.emit({ type: 'turn_end' }) });
    const w = makeWiring([], { cwd });
    w.useSession(leadSession);

    void w.runner.run();
    await leadSession.whenPrompted(1);

    const live = (w.runner as unknown as { scratchpad: Scratchpad }).scratchpad;
    expect(live.get(VERIFICATION_SECTION)).toBeDefined();
    expect(live.isAppendOnly(VERIFICATION_SECTION)).toBe(true);
    expect(() => live.appendTo(VERIFICATION_SECTION, '- A | tree abc | full-suite | PASS')).not.toThrow();

    w.runner.cancel();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('the LEAD spawn threads ONE snapshot into tools:, customTools and the extension factory', async () => {
    // The lead's `createSession` closure is executed by exactly one path in the whole suite — this one.
    // Everything else either stubs `agentRunner.startAgent` wholesale (so the closure never runs) or
    // discards the options. That left the lead half of the spawn invariant unguarded: replacing its
    // third argument with a SECOND `buildAgentToolset(leadCtx).mcp` read passed all 125 tests.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lead-spawn-'));
    const leadSession = new FakeSession({ onPrompt: (_t, sess) => sess.emit({ type: 'turn_end' }) });
    const w = makeWiring([], { cwd });
    w.useSession(leadSession);

    void w.runner.run();
    await leadSession.whenPrompted(1);

    const opts = w.sessionOpts[0]!;
    // `tools:` is the UNION and is never narrowed: a name missing here is evicted from pi's registry
    // permanently, while ToolSearch still reports success.
    expect(opts['tools']).toEqual([...TEAM_BASE_TOOL_NAMES, ...TEAM_MCP_NAMES]);
    // Set-equality with `customTools`, the half pi drops SILENTLY when it is missing.
    expect((opts['customTools'] as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(TEAM_MCP_NAMES));
    // ONE call, and the factory got THAT object — asserted by identity, which is only meaningful now
    // that the fixture allocates a fresh snapshot per call (see `team-mcp-fixture.ts`).
    expect(w.toolsetSnapshots).toHaveLength(1);
    expect(w.factoryMcpSnapshots[0]).toBe(w.toolsetSnapshots[0]);

    w.runner.cancel();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

/**
 * The user-note seam: `PiSession` hands a team agent's cancel note to `ctx.deliverUserNote`, built by
 * `buildLeadContext` / `buildSpecialistContext` and backed by the live run's own sink. It bypasses the
 * MessageBus deliberately, because the bus discards such a note with no signal to the caller.
 */
describe('team wiring: a user note reaches the live run, or says it did not', () => {
  /** The real MCP-context hook, resolved the same way a team agent's tools resolve it. */
  function deliverUserNote(w: Wiring, name: string, text: string): boolean {
    return (w.runner as unknown as {
      buildSpecialistContext: (id: string, scope: string, name: string) => { deliverUserNote: (t: string) => boolean };
    }).buildSpecialistContext(`id-${name}`, `id-${name}#0`, name).deliverUserNote(text);
  }

  function echoesOf(w: Wiring, text: string): ExtensionToWebviewMessage[] {
    return w.webviewMessages.filter((m) => m.type === 'teamAgentUserMessage' && m.content === text);
  }

  it('prompts a running specialist and echoes the note exactly once', async () => {
    const w = makeWiring(['A']);
    const a = startSpecialist(w, 'A');
    await w.settle();

    expect(deliverUserNote(w, 'A', 'the shell command was stopped')).toBe(true);
    await a.whenPrompted(2);

    // First segment of the batch, so the note is prompted verbatim with no `[Message from X]` prefix.
    expect(deliveredPrompts(a)[0]!.split('\n\n')[0]).toBe('the shell command was stopped');
    expect(echoesOf(w, 'the shell command was stopped')).toHaveLength(1);
  });

  it('reaches an agent the model named `user`, which its own bus subscription discards', async () => {
    const w = makeWiring(['user']);
    const u = startSpecialist(w, 'user');
    await w.settle();

    // The bus route first: the subscriber drops `msg.from === config.name`, so this is delivered nowhere
    // and the sender is told nothing. The control probe proves the absence is a filter, not a slow tick.
    w.messageBus.send('user', 'user', 'sent through the bus');
    await drainPastControl(w, u, 'user');
    expect(deliveredPrompts(u).join('\n')).toContain(CONTROL_MESSAGE);
    expect(deliveredPrompts(u).join('\n')).not.toContain('sent through the bus');

    expect(deliverUserNote(w, 'user', 'sent through the seam')).toBe(true);
    await u.whenPrompted(3);
    expect(deliveredPrompts(u)).toContain('sent through the seam');
    expect(echoesOf(w, 'sent through the seam')).toHaveLength(1);
  });

  it('returns false once the run has torn down, echoing nothing', async () => {
    const w = makeWiring(['A']);
    const a = startSpecialist(w, 'A');
    await w.settle();

    w.runner.cancelSpecialist('A');
    await w.settle();

    const before = w.webviewMessages.length;
    expect(deliverUserNote(w, 'A', 'too late')).toBe(false);
    expect(w.webviewMessages).toHaveLength(before);
    expect(deliveredPrompts(a).join('\n')).not.toContain('too late');
  });
});

/**
 * The engine-side standby park. Every other session in this file ends its turn on its own, so nothing
 * here observed the `shouldStopAfterTurn` hook the AgentRunner installs. These drive a session that
 * ends its turn ONLY when that hook says so, spawned through the real `startSpecialist` path.
 */
describe('team wiring: a team_standby call parks the specialist, which still wakes', () => {
  interface StandbySpecialist { session: FakeSession; stops: boolean[] }

  /**
   * A specialist whose opening turn calls `team_standby` and would otherwise keep working: the fake
   * resolves that prompt only if the hook stops the turn, and `stops` records what the hook answered.
   */
  function startStandbySpecialist(w: Wiring, name: string): StandbySpecialist {
    const stops: boolean[] = [];
    const session = new FakeSession({
      onPrompt: (_t, s) => {
        if (s.prompts.length > 1) { s.emit({ type: 'turn_end' }); return; }
        // What the real tool does before returning its text result.
        w.runner.enterStandby(name);
        void s.runTurn([{ id: 'tc-1', name: 'team_standby' }]).then((stop) => { stops.push(stop); });
      },
    });
    w.useSession(session);
    w.runner.startSpecialist(name, `task for ${name} that is descriptive enough`);
    return { session, stops };
  }

  it('ends the turn on team_standby and makes no further prompt', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startStandbySpecialist(w, 'B');
    await w.settle();

    expect(b.stops).toEqual([true]);
    expect(deliveredPrompts(b.session)).toEqual([]);
  });

  it('wakes the parked specialist on a direct message', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startStandbySpecialist(w, 'B');
    await w.settle();

    expect(b.stops).toEqual([true]);

    w.messageBus.send('A', 'B', 'my findings are posted');
    await b.session.whenPrompted(2);

    expect(deliveredPrompts(b.session).join('\n')).toContain('my findings are posted');
  });

  it('wakes the parked specialist on a peer scratchpad write', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startStandbySpecialist(w, 'B');
    await w.settle();

    expect(b.stops).toEqual([true]);

    w.scratchpad.set('a-findings', 'A posted findings', 'A');
    await b.session.whenPrompted(2);

    expect(noticePrompts(b.session)).toHaveLength(1);
    expect(noticePrompts(b.session)[0]).toContain('"a-findings" updated by A');
  });
});

/**
 * The engine-side report_complete park, and where the sign-off it carries ends up. Measured across the
 * team logs, 821 of 851 report_complete calls were followed by another request in the same turn, almost
 * always one text-only message: the closing statement the tool gave the model nowhere to put. The
 * summary parameter is that place, so it has to reach the card and the transcript, and the turn has to
 * end at the call.
 */
describe('team wiring: a team_report_complete call parks the specialist with its sign-off', () => {
  interface ReportingSpecialist { session: FakeSession; stops: boolean[] }

  /** The specialist's REAL MCP context, so the path the tool takes is the path under test. */
  function specialistContext(w: Wiring, name: string): { reportComplete: (n: string, summary: string) => void } {
    return (w.runner as unknown as {
      buildSpecialistContext: (id: string, scope: string, name: string) => { reportComplete: (n: string, summary: string) => void };
    }).buildSpecialistContext(`id-${name}`, `id-${name}#0`, name);
  }

  function agentOf(w: Wiring, name: string): TeamAgent {
    return (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get(name)!;
  }

  /** Flush microtasks until `predicate` holds, so no assertion depends on a tick count. */
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await Promise.resolve();
  }

  /**
   * A specialist that reports complete on each turn it has a summary for, and would otherwise keep
   * working: the fake resolves that prompt only if the hook stops the turn, and `stops` records what the
   * hook answered on each one.
   */
  function startReportingSpecialist(
    w: Wiring,
    name: string,
    summaries: string[],
    opts?: { trailingText?: string; duringTurn?: () => void },
  ): ReportingSpecialist {
    const remaining = [...summaries];
    const stops: boolean[] = [];
    const session = new FakeSession({
      onPrompt: (_t, s) => {
        const summary = remaining.shift();
        if (summary === undefined) { s.emit({ type: 'turn_end' }); return; }
        if (opts?.trailingText) {
          s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: opts.trailingText }] } });
        }
        // What the real tool does before returning its text result.
        specialistContext(w, name).reportComplete(name, summary);
        opts?.duringTurn?.();
        void s.runTurn([{ id: `tc-${stops.length}`, name: 'team_report_complete' }]).then((stop) => { stops.push(stop); });
      },
    });
    w.useSession(session);
    w.runner.startSpecialist(name, `task for ${name} that is descriptive enough`);
    return { session, stops };
  }

  it('ends the turn on team_report_complete and makes no further prompt', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startReportingSpecialist(w, 'B', ['sign-off from B']);
    await w.settle();

    expect(b.stops).toEqual([true]);
    expect(deliveredPrompts(b.session)).toEqual([]);
  });

  it('leaves the specialist alive in awaiting-review, still able to take a revision request', async () => {
    const w = makeWiring(['A']);
    const a = startReportingSpecialist(w, 'A', ['sign-off from A']);
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    expect(agentOf(w, 'A').status).toBe('awaiting-review');

    w.runner.requestRevision('A', 'the second case is still unhandled');
    await a.session.whenPrompted(2);

    expect(deliveredPrompts(a.session).join('\n')).toContain('the second case is still unhandled');
  });

  it('leaves the specialist alive in awaiting-review, still able to be approved', async () => {
    const w = makeWiring(['A']);
    const a = startReportingSpecialist(w, 'A', ['sign-off from A']);
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    w.runner.approveSpecialist('A');
    await until(() => agentOf(w, 'A').status === 'completed');

    expect(agentOf(w, 'A').status).toBe('completed');
    expect(a.stops).toEqual([true]);
  });

  it('still delivers a message that arrived during the report_complete turn', async () => {
    const w = makeWiring(['A', 'B']);
    startSpecialist(w, 'A');
    const b = startReportingSpecialist(w, 'B', ['sign-off from B'], {
      duringTurn: () => w.messageBus.send('A', 'B', 'one more thing before you park'),
    });
    await b.session.whenPrompted(2);

    expect(deliveredPrompts(b.session).join('\n')).toContain('one more thing before you park');
  });

  it('carries the sign-off to the agent card and the agent-completed entry, over trailing assistant text', async () => {
    const w = makeWiring(['A']);
    const summary = 'shipped the parser, all four commands pass, nothing left open';
    startReportingSpecialist(w, 'A', [summary], { trailingText: 'let me write that up for you' });
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    w.runner.approveSpecialist('A');
    await until(() => w.teamEntries.some((e) => e['type'] === 'agent-completed'));

    expect(agentOf(w, 'A').finalResponse).toBe(summary);
    const completed = w.teamEntries.find((e) => e['type'] === 'agent-completed' && e['name'] === 'A');
    expect(completed?.['result']).toBe(summary);
  });

  it('drops a sign-off the revision superseded, so a specialist that dies mid-revision carries none', async () => {
    // The lead synthesizes from finalResponse. A confident pre-revision sign-off surviving the revision
    // that rejected it would describe work the specialist never finished.
    const w = makeWiring(['A']);
    const a = startReportingSpecialist(w, 'A', ['first pass, one case unhandled']);
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    w.runner.requestRevision('A', 'handle the second case');
    await a.session.whenPrompted(2);
    w.runner.cancelSpecialist('A');
    await until(() => w.teamEntries.some((e) => e['type'] === 'agent-completed'));

    expect(agentOf(w, 'A').finalResponse).toBeNull();
    const completed = w.teamEntries.find((e) => e['type'] === 'agent-completed' && e['name'] === 'A');
    expect(completed?.['result']).toBeNull();
  });

  it('takes the newest sign-off when a revision round produces a second one', async () => {
    const w = makeWiring(['A']);
    const a = startReportingSpecialist(w, 'A', ['first pass, one case unhandled', 'second case handled, suites pass']);
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    w.runner.requestRevision('A', 'handle the second case');
    await a.session.whenPrompted(2);
    await until(() => agentOf(w, 'A').status === 'awaiting-review');

    w.runner.approveSpecialist('A');
    await until(() => w.teamEntries.some((e) => e['type'] === 'agent-completed'));

    expect(a.stops).toEqual([true, true]);
    expect(agentOf(w, 'A').finalResponse).toBe('second case handled, suites pass');
  });
});

/**
 * Per-attempt state a re-run must not inherit, and the per-agent billing flag a card labels its cost
 * with. Both are set on the runner's spawn paths, so they are asserted through the real ones.
 */
describe('team wiring: a redispatch is a fresh attempt, and each agent carries its own billing flag', () => {
  function agentOf(w: Wiring, name: string): TeamAgent {
    return (w.runner as unknown as { agents: Map<string, TeamAgent> }).agents.get(name)!;
  }

  /** Flush microtasks until `predicate` holds, so no assertion depends on a tick count. */
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await Promise.resolve();
  }

  /** Cancel a running specialist and queue the session its re-run will take. */
  async function cancelAndQueueRerun(w: Wiring, name: string): Promise<FakeSession> {
    w.runner.cancelSpecialist(name);
    await until(() => agentOf(w, name).status === 'cancelled');
    const session = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    w.useSession(session);
    return session;
  }

  it('gives a redispatched specialist a full first read, not the unchanged marker', async () => {
    // The re-run is a new session with empty model context, so read state recorded by the failed
    // attempt describes text this attempt has never seen.
    const w = makeWiring(['A']);
    w.scratchpad.seedImmutable('mission-brief', 'the authoritative spec');
    startSpecialist(w, 'A');
    await w.settle();
    w.scratchpad.markAllRead('A');
    w.scratchpad.recordReadOutcome('A', 'full');
    expect(w.scratchpad.hasCurrentRead('A', 'mission-brief')).toBe(true);

    await cancelAndQueueRerun(w, 'A');
    w.runner.redispatchSpecialist('A', 'second attempt at the same task');

    expect(w.scratchpad.hasCurrentRead('A', 'mission-brief')).toBe(false);
    expect(w.scratchpad.getReadStats('A')).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  it('leaves every other reader read state alone when one specialist is redispatched', async () => {
    const w = makeWiring(['A', 'B']);
    w.scratchpad.seedImmutable('mission-brief', 'the authoritative spec');
    startSpecialist(w, 'A');
    startSpecialist(w, 'B');
    await w.settle();
    w.scratchpad.markAllRead('A');
    w.scratchpad.markAllRead('B');

    await cancelAndQueueRerun(w, 'A');
    w.runner.redispatchSpecialist('A', 'second attempt at the same task');

    expect(w.scratchpad.hasCurrentRead('B', 'mission-brief')).toBe(true);
  });

  it('takes the specialist billing flag from its own role resolution, on spawn and on redispatch', async () => {
    const w = makeWiring(['A']);
    startSpecialist(w, 'A');
    await w.settle();

    expect(agentOf(w, 'A').dollarBilled).toBe(true);
    const spawned = w.teamEntries.filter((e) => e['type'] === 'agent-spawned' && e['name'] === 'A');
    expect(spawned.map((e) => e['dollarBilled'])).toEqual([true]);

    agentOf(w, 'A').dollarBilled = false;
    await cancelAndQueueRerun(w, 'A');
    w.runner.redispatchSpecialist('A', 'second attempt at the same task');

    expect(agentOf(w, 'A').dollarBilled).toBe(true);
    expect(w.teamEntries.filter((e) => e['type'] === 'agent-spawned' && e['name'] === 'A')).toHaveLength(2);
  });

  it('sends the specialist billing flag to the webview on spawn and on redispatch', async () => {
    // teamStarted goes out before any specialist spawns, so the card carries the unknown-billing
    // placeholder until a status update corrects it.
    const w = makeWiring(['A']);
    startSpecialist(w, 'A');
    await w.settle();

    // The AgentRunner emits its own running update and knows nothing about billing, so the flag marks
    // the spawn updates the runner sends.
    const billed = (): Array<boolean | undefined> => w.webviewMessages
      .filter((m) => m.type === 'teamAgentStatusUpdate' && 'dollarBilled' in m)
      .map((m) => (m as { dollarBilled?: boolean }).dollarBilled);
    expect(billed()).toEqual([true]);

    await cancelAndQueueRerun(w, 'A');
    w.runner.redispatchSpecialist('A', 'second attempt at the same task');

    expect(billed()).toEqual([true, true]);
  });

  it('takes the lead billing flag from the lead resolution on the real run path', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-billing-'));
    const leadSession = new FakeSession({ onPrompt: (_t, sess) => sess.emit({ type: 'turn_end' }) });
    const w = makeWiring(['A'], { cwd });
    w.useSession(leadSession);

    void w.runner.run();
    await leadSession.whenPrompted(1);

    expect(agentOf(w, 'Lead').dollarBilled).toBe(false);
    // A specialist has no resolution until it spawns, so it starts on the safe side of the label.
    expect(agentOf(w, 'A').dollarBilled).toBe(true);

    w.runner.cancel();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

/**
 * Usage totals are accumulated per `message_end` inside the AgentRunner and only reach a reopened team
 * through the `agent-completed` entry, so the sum is asserted where the entry is written.
 */
describe('team wiring: the persisted usage totals are the run sum, not its last turn', () => {
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await Promise.resolve();
  }

  it('sums every usage component across turns into the agent-completed entry', async () => {
    const w = makeWiring(['A']);
    const session = new FakeSession({
      onPrompt: (_t, s) => {
        s.emitAssistantUsage({ input: 10, output: 5, cacheRead: 1_000, cacheWrite: 2 });
        s.emitAssistantUsage({ input: 20, output: 7, cacheRead: 3_000, cacheWrite: 4 });
        s.emit({ type: 'turn_end' });
      },
    });
    w.useSession(session);
    w.runner.startSpecialist('A', 'task for A that is descriptive enough');
    await w.settle();

    w.runner.cancelSpecialist('A');
    await until(() => w.teamEntries.some((e) => e['type'] === 'agent-completed'));

    const completed = w.teamEntries.find((e) => e['type'] === 'agent-completed' && e['name'] === 'A');
    // Each request pays for its own cached prefix, so the charge is the sum and not the last reading.
    expect(completed?.['cacheReadTokens']).toBe(4_000);
    expect(completed?.['totalInputTokens']).toBe(30);
    expect(completed?.['totalOutputTokens']).toBe(12);
    expect(completed?.['cacheCreationTokens']).toBe(6);
  });
});
