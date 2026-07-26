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
    cacheCreationTokens: 0, costUsd: 0, finalResponse: null, error: null, logFilePath: null,
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
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model' }),
    engine: {
      // Each spawn takes the next session the test queued via `useSession`, so the REAL AgentRunner
      // drives a real prompt loop against it.
      createSession: async () => {
        const session = pendingSessions.shift();
        if (!session) throw new Error('queue a FakeSession with useSession() before spawning');
        return session as never;
      },
      forgetSession: () => undefined,
      agentToolNames: () => [],
      buildAgentCustomTools: () => [],
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
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
    runner, scratchpad, messageBus, teamEntries, webviewMessages,
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
      (m) => m.type === 'teamMessage' && m.message.content.includes(NOTICE),
    )!;
    expect(Object.keys((emitted as { message: Record<string, unknown> }).message).sort()).toEqual(
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

    w.runner.reportComplete('A');
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
    w.runner.reportComplete('A');
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

    w.runner.reportComplete('A');
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
    expect(() => live.appendTo(VERIFICATION_SECTION, '- A | tree abc | full-suite | PASS', 'Lead')).not.toThrow();

    w.runner.cancel();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
