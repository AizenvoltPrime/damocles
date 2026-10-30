import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// The log and the member files the runner writes go to a throwaway home. The async factory is hoisted above the persistence import.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-member-live-')) };
});

import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamService } from '../index';
import { TeamRunner } from '../team-runner';
import { AgentRunner } from '../agent-runner';
import { TeamPersistence } from '../persistence';
import { Scratchpad } from '../scratchpad';
import { MessageBus } from '../message-bus';
import { FakeSession } from './fake-session';
import { initPiLoader } from '../../pi-session/pi-loader';
import { ensurePiSessionDir } from '../../pi-session/session-store';
import { teamMemberSessionId, teamMembersDir, type TeamMemberLaunchData } from '../../pi-session/agent-records';
import { DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_TURN_STOPPED_ENTRY } from '../../pi-session/session-store/constants';
import { teamAgentToolset } from './team-mcp-fixture';
import { stubCheckpointWriter } from './checkpoint-writer-stub';
import { createTeamHandlers as createCoreTeamHandlers } from '../../chat-panel/message-router/handlers/team-handlers';
import type { HandlerContext, HandlerDependencies } from '../../chat-panel/message-router/types';
import type { MemberTranscript, MemberTranscriptSource, TeamAgent, TeamConfig } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { useTeamStore, type AgentChatMessage } from '@/stores/useTeamStore';
import { createTeamHandlers } from '@/composables/message-handler/handlers/team-handlers';

const TEAM_ID = '3f1d7a52-5b0e-4c1e-9a43-6a0e2f1c9b11';
const SESSION_ID = '7c2e9b40-1d3a-4f6e-8b25-0d4c6e8a1f22';
const LEAD = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c33';
const ALPHA = 'b4e3d2c1-0f9e-4d8c-8b7a-6f5e4d3c2b44';

type PiMessage = Parameters<SessionManager['appendMessage']>[0];

function makeAgent(agentId: string, name: string, role: TeamAgent['role'], attempt: number): TeamAgent {
  return {
    agentId, teamId: TEAM_ID, name, role, attempt, specialization: '', description: null, task: null,
    status: 'pending', model: 'test', profileId: null, activeMs: 0, runningSince: null,
    toolCallCount: 0, carriedToolCallCount: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, costUsd: 0,
    carriedUsage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    dollarBilled: false, effort: null, finalResponse: null, result: null, error: null, logFilePath: null,
  };
}

/** A chat page's team store, fed through the real webview team handlers. */
function page() {
  const pinia: Pinia = createPinia();
  const handlers = createTeamHandlers() as Record<string, (m: ExtensionToWebviewMessage, ctx: unknown) => void>;
  return {
    deliver(message: ExtensionToWebviewMessage): void {
      setActivePinia(pinia);
      handlers[message.type]?.(message, {});
    },
    store() {
      setActivePinia(pinia);
      return useTeamStore();
    },
  };
}
type Page = ReturnType<typeof page>;

/** What the member's transcript overlay shows; the row ids, which no two loads share, are left out. */
function shown(open: Page): unknown[] {
  return (open.store().agentMessages[ALPHA] ?? []).map((m: AgentChatMessage) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length ? { calls: m.toolCalls.map((t) => [t.id, t.status, t.result ?? null, t.abandonReason ?? null]) } : {}),
  }));
}

/** Write a member attempt that ended earlier through pi's own SessionManager, into the dir the runner gives it. */
function writeEarlierAttempt(cwd: string, attempt: number, messages: PiMessage[]): void {
  const dir = teamMembersDir(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID);
  const sm = SessionManager.create(cwd, dir, { id: teamMemberSessionId(ALPHA, attempt) });
  const launch: TeamMemberLaunchData = { agentId: ALPHA, kind: 'team-member', teamId: TEAM_ID, attempt, memberName: 'alpha', role: 'specialist', task: 'an earlier attempt' };
  sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, launch);
  for (const message of messages) sm.appendMessage(message);
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const userMessage = (text: string): PiMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
const answer = (text: string): PiMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage, stopReason: 'stop', timestamp: Date.now() }) as unknown as PiMessage;

const runners: TeamRunner[] = [];

/**
 * A real TeamRunner and AgentRunner over a fake pi session whose entries reach a real member file, a real `TeamService`
 * holding the runner, whose live posts reach every open page, and the core `requestTeamAgentData` handler, whose reply
 * reaches the page that asked. `run()` is not called, so the collaborators it builds are injected, as
 * `redispatch-parity.test.ts` does.
 */
function makeHarness(cwd: string, alphaAttempt = 0) {
  const pages: Page[] = [];
  const pendingSessions: FakeSession[] = [];
  const config = {
    teamId: TEAM_ID, toolUseId: 'toolu_1', title: 't', brief: 'b', cwd, persistenceSessionId: SESSION_ID, permissionMode: 'default' as const,
    agents: [{ name: 'lead', role: 'lead' as const }, { name: 'alpha', role: 'specialist' as const }],
    resolveRoleModel: () => ({ modelLabel: 'm', dollarBilled: false }),
    engine: {
      createSession: async (opts: { store: { kind: string; dir?: string; id?: string } }) => {
        const session = pendingSessions.shift();
        if (!session) throw new Error('queue a FakeSession before spawning');
        const file = SessionManager.create(cwd, opts.store.dir!, { id: opts.store.id! });
        session.mirror = { appendMessage: (m) => file.appendMessage(m as never), appendCustomEntry: (t, d) => file.appendCustomEntry(t, d) };
        session.sessionFile = file.getSessionFile();
        return session as never;
      },
      forgetSession: () => undefined,
      buildAgentToolset: () => teamAgentToolset(),
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;
  const runner = new TeamRunner(config, (m) => { for (const open of pages) open.deliver(m); });
  runners.push(runner);
  const target = runner as unknown as Record<string, unknown>;
  const persistence = new TeamPersistence(cwd, SESSION_ID);
  target['persistence'] = persistence;
  target['checkpointWriter'] = stubCheckpointWriter();
  target['agentRunner'] = new AgentRunner();
  target['messageBus'] = new MessageBus(TEAM_ID);
  target['scratchpad'] = new Scratchpad();
  const agents = target['agents'] as Map<string, TeamAgent>;
  agents.set('lead', makeAgent(LEAD, 'lead', 'lead', 0));
  agents.set('alpha', makeAgent(ALPHA, 'alpha', 'specialist', alphaAttempt));
  (runner as unknown as { installSubscribers: () => void }).installSubscribers();
  persistence.initTeamFile(TEAM_ID);

  // the service the panel's team handlers read, holding this runner as the team it runs
  const teamService = new TeamService({} as never);
  (teamService as unknown as { setActiveTeam: (teamId: string, runner: TeamRunner) => void }).setActiveTeam(TEAM_ID, runner);
  /** The page asks for a member's transcript, as its overlay does when it opens; resolves once core answered. */
  const openTranscript = async (asking: Page, agentId: string): Promise<void> => {
    const deps = { postMessage: (_host: unknown, m: ExtensionToWebviewMessage) => asking.deliver(m) } as unknown as HandlerDependencies;
    const ctx = { session: { persistenceSessionId: SESSION_ID, teamService }, folder: { fsPath: cwd }, reply: {}, panelId: 'p1' } as unknown as HandlerContext;
    await createCoreTeamHandlers(deps).requestTeamAgentData!({ type: 'requestTeamAgentData', teamId: TEAM_ID, agentId } as never, ctx);
  };
  const queueSession = (): FakeSession => {
    const session = new FakeSession();
    pendingSessions.push(session);
    return session;
  };
  const settled = async (): Promise<void> => {
    const runs = runner as unknown as { specialistPromises: Map<string, Promise<unknown>> };
    await Promise.allSettled([...runs.specialistPromises.values()]);
  };
  return { runner, teamService, pages, openTranscript, queueSession, settled };
}

const delta = (text: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });

beforeAll(async () => {
  await initPiLoader();
});

afterAll(() => rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    const runs = runner as unknown as { teamAbort: AbortController; specialistPromises: Map<string, Promise<unknown>> };
    runs.teamAbort.abort();
    await Promise.allSettled([...runs.specialistPromises.values()]);
  }
});

describe("a running member's transcript", () => {
  it("opening a member's transcript mid-stream shows its in-flight text once, and the next delta appends to it", async () => {
    const h = makeHarness(join(DAMOCLES_HOME_DIR, 'mid-stream'));
    const watcher = page();
    h.pages.push(watcher);
    const session = h.queueSession();
    h.runner.startSpecialist('alpha', 'Label', 'survey the repo');
    await session.whenModelCalled(1);
    const LS = { type: 'toolCall', id: 'tc-ls', name: 'bash', arguments: { command: 'ls' } };
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Listing' }, LS], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-ls', toolName: 'bash', args: LS.arguments });
    session.emit({ type: 'tool_execution_update', toolCallId: 'tc-ls', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'a.ts\n' }], details: {} } });
    const result = { role: 'toolResult', toolCallId: 'tc-ls', toolName: 'bash', content: [{ type: 'text', text: 'a.ts' }], isError: false };
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-ls', toolName: 'bash', result, isError: false });
    session.emit({ type: 'message_start', message: result });
    session.emit({ type: 'message_end', message: result });
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit(delta('Hel'));
    session.emit(delta('lo'));

    // a page that loaded again mid-stream, and the page that watched, both open the transcript now
    const reloaded = page();
    h.pages.push(reloaded);
    await h.openTranscript(reloaded, ALPHA);
    await h.openTranscript(watcher, ALPHA);
    for (const open of [reloaded, watcher]) {
      expect(open.store().agentStreaming[ALPHA]?.text).toBe('Hello');
      expect(open.store().agentMessages[ALPHA]?.map((m) => [m.role, m.content])).toEqual([['user', 'survey the repo'], ['assistant', 'Listing']]);
      expect(open.store().agentMessages[ALPHA]?.[1]?.toolCalls?.map((t) => [t.id, t.status])).toEqual([['tc-ls', 'completed']]);
    }

    session.emit(delta(' world'));
    for (const open of [reloaded, watcher]) expect(open.store().agentStreaming[ALPHA]?.text).toBe('Hello world');
  });

  it('shows a call the member still runs as running, with its latest output, never as unrecorded', async () => {
    const h = makeHarness(join(DAMOCLES_HOME_DIR, 'running-call'));
    const session = h.queueSession();
    h.runner.startSpecialist('alpha', 'Label', 'survey the repo');
    await session.whenModelCalled(1);
    const LS = { type: 'toolCall', id: 'tc-ls', name: 'bash', arguments: { command: 'ls' } };
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [LS], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-ls', toolName: 'bash', args: LS.arguments });
    session.emit({ type: 'tool_execution_update', toolCallId: 'tc-ls', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'a.ts\n' }], details: {} } });

    const reloaded = page();
    h.pages.push(reloaded);
    await h.openTranscript(reloaded, ALPHA);
    expect(reloaded.store().agentMessages[ALPHA]?.at(-1)?.toolCalls?.map((t) => [t.id, t.status, t.liveOutput])).toEqual([['tc-ls', 'running', 'a.ts\n']]);
  });

  // pi stores a parallel batch's results only once every call of it ended (`agent-loop.js:417-464`).
  it('shows a call of a parallel batch that ended while another still runs with its outcome, never as unrecorded', async () => {
    const h = makeHarness(join(DAMOCLES_HOME_DIR, 'parallel-batch'));
    const session = h.queueSession();
    h.runner.startSpecialist('alpha', 'Label', 'survey the repo');
    await session.whenModelCalled(1);
    const READ = { type: 'toolCall', id: 'tc-read', name: 'read', arguments: { path: 'a.ts' } };
    const LS = { type: 'toolCall', id: 'tc-ls', name: 'bash', arguments: { command: 'ls' } };
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [READ, LS], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-read', toolName: 'read', args: READ.arguments });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-ls', toolName: 'bash', args: LS.arguments });
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-read', toolName: 'read', result: { content: [{ type: 'text', text: 'export {}' }], details: {} }, isError: false, durationMs: 4 });

    const reloaded = page();
    h.pages.push(reloaded);
    const answer: ExtensionToWebviewMessage[] = [];
    await h.openTranscript({ ...reloaded, deliver: (m) => { answer.push(m); reloaded.deliver(m); } }, ALPHA);
    expect(reloaded.store().agentMessages[ALPHA]?.at(-1)?.toolCalls?.map((t) => [t.id, t.status, t.result ?? null])).toEqual([
      ['tc-read', 'completed', 'export {}'],
      ['tc-ls', 'running', null],
    ]);
    // the run still owns both calls, and the ended one's result follows the transcript, as the subagent bridge sends it
    const loaded = answer.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentDataLoaded' }> => m.type === 'teamAgentDataLoaded');
    expect(loaded?.messages.at(-1)?.content.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.live === true])).toEqual([['tc-read', true], ['tc-ls', true]]);
    expect(answer.slice(answer.indexOf(loaded!) + 1).map((m) => m.type)).toEqual(['teamAgentToolResult']);
  });

  // A Stop while the call waits at the permission gate settles it before it runs (`registerAbortSettledCallRecord`).
  it('a re-sealed message replaces the copy a page loaded mid-work, so the page shows it once', async () => {
    const h = makeHarness(join(DAMOCLES_HOME_DIR, 're-seal'));
    const watcher = page();
    h.pages.push(watcher);
    const session = h.queueSession();
    h.runner.startSpecialist('alpha', 'Label', 'survey the repo');
    await session.whenModelCalled(1);
    const RM = { type: 'toolCall', id: 'tc-rm', name: 'bash', arguments: { command: 'rm -rf build' } };
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Cleaning' }, RM], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-rm', toolName: 'bash', args: RM.arguments });

    const reloaded = page();
    h.pages.push(reloaded);
    await h.openTranscript(reloaded, ALPHA);
    // pi appends the record and reports it before listeners get the settled call's end
    session.sessionManager.appendCustomEntry(DAMOCLES_TURN_STOPPED_ENTRY, { toolCallIds: ['tc-rm'], entryIds: [] });
    session.emit({ type: 'entry_appended', entry: session.branch.at(-1) });
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-rm', toolName: 'bash', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} }, isError: true });

    for (const open of [reloaded, watcher]) {
      expect(shown(open).filter((m) => (m as { role: string }).role === 'assistant')).toEqual([
        { role: 'assistant', content: 'Cleaning', calls: [['tc-rm', 'abandoned', null, 'stopped']] },
      ]);
    }
  });

  it("on a member's second attempt, the transcript opened mid-run equals the file reload once the run ended, each attempt once", async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'second-attempt');
    writeEarlierAttempt(cwd, 0, [userMessage('an earlier attempt'), answer('Gave up.')]);
    const h = makeHarness(cwd, 1);
    const session = h.queueSession();
    h.runner.startSpecialist('alpha', 'Label', 'survey the repo');
    await session.whenModelCalled(1);
    const LS = { type: 'toolCall', id: 'tc-ls', name: 'bash', arguments: { command: 'ls' } };
    const result = { role: 'toolResult', toolCallId: 'tc-ls', toolName: 'bash', content: [{ type: 'text', text: 'a.ts' }], isError: false };
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Listing' }, LS], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-ls', toolName: 'bash', args: LS.arguments });
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-ls', toolName: 'bash', result, isError: false, durationMs: 3 });
    session.emit({ type: 'message_start', message: result });
    session.emit({ type: 'message_end', message: result });

    const joined = page();
    h.pages.push(joined);
    await h.openTranscript(joined, ALPHA);
    expect(shown(joined)).toEqual([
      { role: 'user', content: 'an earlier attempt' },
      { role: 'assistant', content: 'Gave up.' },
      { role: 'user', content: 'survey the repo' },
      { role: 'assistant', content: 'Listing', calls: [['tc-ls', 'completed', 'a.ts', null]] },
    ]);

    // the call's message ends its turn's first step, and the next call answers
    await session.endTurn();
    await session.whenModelCalled(2);
    await session.endTurn('Two files.');
    h.runner.cancelSpecialist('alpha');
    await h.settled();

    // the run let go of the session, so a page that opens the transcript now reads every attempt from its file
    expect(h.teamService.liveMember(TEAM_ID, ALPHA)).toBeNull();
    const reloaded = page();
    await h.openTranscript(reloaded, ALPHA);
    expect(shown(joined)).toEqual(shown(reloaded));
    expect(shown(reloaded).filter((m) => (m as { content: string }).content === 'Gave up.')).toHaveLength(1);
  });
});

describe('TeamService.liveMember', () => {
  const transcript: MemberTranscript = { messages: [{ id: 'live-1', role: 'assistant', content: [{ type: 'text', text: 'on it' }] }], outputs: [], results: [] };

  function serviceWith(bound: () => MemberTranscriptSource | undefined): TeamService {
    const service = new TeamService({} as never);
    const runner = { memberTranscript: () => bound() } as unknown as TeamRunner;
    (service as unknown as { setActiveTeam: (teamId: string, runner: TeamRunner) => void }).setActiveTeam(TEAM_ID, runner);
    return service;
  }

  it('names the attempt the bound run holds without reading its transcript, and reads it while that attempt is bound', () => {
    const read = vi.fn(() => transcript);
    const live = serviceWith(() => ({ attempt: 1, read }))!.liveMember(TEAM_ID, ALPHA);
    expect(live?.attempt).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(live?.read()).toBe(transcript);
  });

  // The handler reads the earlier attempts' files between the two, which a redispatch can overtake.
  it('reads nothing once a run of another attempt is bound, so the caller falls back to the files', () => {
    let bound: MemberTranscriptSource | undefined = { attempt: 1, read: () => transcript };
    const live = serviceWith(() => bound).liveMember(TEAM_ID, ALPHA);
    bound = { attempt: 2, read: () => transcript };
    expect(live?.read()).toBeUndefined();
    bound = undefined;
    expect(live?.read()).toBeUndefined();
  });

  it('is null for another team and for a member with no subscribed run', () => {
    expect(serviceWith(() => ({ attempt: 0, read: () => transcript })).liveMember('another-team', ALPHA)).toBeNull();
    expect(serviceWith(() => undefined).liveMember(TEAM_ID, ALPHA)).toBeNull();
  });
});
