import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import { openUsageDatabase, type UsageDatabase } from '../database';
import { indexUsage } from '../indexer';
import { loadRates, queryTotals } from '../queries';
import type { UsageStatsModel } from '../worker-protocol';
import { SubagentStreamBridge } from '../../pi-session/subagents/subagent-stream-bridge';
import { readAgentFile } from '../../pi-session/agent-records';
import { DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY } from '../../pi-session/session-store/constants';
import type { AgentUsageTotals } from '../../../shared/usage-accounting';

/**
 * The index must bill a pi-written session file exactly as pi's own `AgentSession.getSessionStats()` does.
 * Both sides read the same file: pi through a real `AgentSession` over `SessionManager.open`, the index
 * through `indexUsage`.
 */

const MODELS: UsageStatsModel[] = [
  { key: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', inputRatePerToken: 3e-6 },
  { key: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', inputRatePerToken: 1e-6 },
];

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage {
  return {
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: total * 0.2, output: total * 0.5, cacheRead: total * 0.1, cacheWrite: total * 0.2, total },
  };
}

function assistant(stopReason: 'stop' | 'aborted' | 'error' | 'toolUse', u: Usage) {
  return {
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic',
    model: 'claude-sonnet-4-5', usage: u, stopReason, timestamp: Date.now(),
    ...(stopReason === 'error' ? { errorMessage: 'overloaded' } : {}),
  } as never;
}

const made: string[] = [];
const sessions: AgentSession[] = [];
const dbs: UsageDatabase[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real AgentSession over an existing session file. */
async function openPiSession(root: string, file: string, sessionDir: string): Promise<AgentSession> {
  const cwd = path.join(root, 'cwd');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
  } as never);
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.open(file, sessionDir),
  } as never);
  sessions.push(session);
  return session;
}

/** pi's own session total for a file, from a real AgentSession. */
async function piSessionStats(root: string, file: string, sessionDir: string) {
  return (await openPiSession(root, file, sessionDir)).getSessionStats();
}

describe('pi parity', () => {
  it('indexes a pi-written session, and a pi fork of it, to exactly pi\'s getSessionStats() total', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-usage-parity-')));
    made.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionDir = path.join(sessionsDir, '--repo--');

    const sm = SessionManager.create(path.join(root, 'cwd'), sessionDir);
    sm.appendSessionInfo('Parity check');
    sm.appendMessage({ role: 'user', content: 'start', timestamp: Date.now() });
    const first = sm.appendMessage(assistant('toolUse', usage(1200, 300, 8000, 2000, 0.0421)));
    sm.appendMessage({
      role: 'toolResult', toolCallId: 'call-1', toolName: 'Agent', content: [{ type: 'text', text: 'done' }], isError: false,
      usage: usage(50, 20, 0, 0, 0.0007), timestamp: Date.now(),
    } as never);
    sm.appendMessage(assistant('aborted', usage(400, 10, 9000, 0, 0.0043)));
    sm.appendMessage(assistant('error', usage(700, 0, 0, 0, 0.0021)));
    // Tokens with no recorded price: pi adds zero cost, and so must the index.
    sm.appendMessage(assistant('stop', usage(90, 30, 0, 0, 0)));
    sm.appendUsage('cache_warm', 'anthropic', 'claude-haiku-4-5-20251001', usage(0, 1, 30_000, 0, 0.003));
    sm.appendCompaction('summary of the start', first, 20_000, undefined, false, usage(20_000, 800, 0, 0, 0.072));
    sm.appendMessage(assistant('stop', usage(300, 120, 15_000, 500, 0.0077)));
    sm.branchWithSummary(first, 'summary of the abandoned branch', undefined, false, usage(5000, 200, 0, 0, 0.018));
    const leaf = sm.appendMessage(assistant('stop', usage(100, 40, 12_000, 0, 0.0052)));
    const original = sm.getSessionFile()!;
    expect(fs.existsSync(original)).toBe(true);

    // A fork copies the branch's entries verbatim into a new file with a later header.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fork = SessionManager.open(original, sessionDir).createBranchedSession(leaf)!;
    expect(fork).not.toBe(original);

    const db = openUsageDatabase(path.join(root, 'usage', 'usage.db'), () => undefined);
    dbs.push(db);
    const logs: string[] = [];
    const summary = await indexUsage({ db, sessionsDir, ledgerPath: path.join(root, 'usage', 'subcalls.jsonl'), models: MODELS, log: (m) => logs.push(m) });
    expect(summary, logs.join('\n')).toMatchObject({ filesTotal: 2, filesFailed: 0 });
    loadRates(db, MODELS);
    const indexed = queryTotals(db, { startMs: 0, endMs: Number.MAX_SAFE_INTEGER }, { modelKeys: [], projectKeys: [] }, 'UTC');

    const pi = await piSessionStats(root, original, sessionDir);
    const piFork = await piSessionStats(root, fork, sessionDir);
    // The fork holds billed copies, so a double count would show.
    expect(piFork.cost).toBeGreaterThan(0);
    // Every entry kind above is billed by pi, including the abandoned branch.
    expect(pi.cost).toBeCloseTo(0.0421 + 0.0007 + 0.0043 + 0.0021 + 0 + 0.003 + 0.072 + 0.0077 + 0.018 + 0.0052, 12);

    expect(indexed.cost).toBeCloseTo(pi.cost, 12);
    expect({ input: indexed.input, output: indexed.output, cacheRead: indexed.cacheRead, cacheWrite: indexed.cacheWrite }).toEqual({
      input: pi.tokens.input, output: pi.tokens.output, cacheRead: pi.tokens.cacheRead, cacheWrite: pi.tokens.cacheWrite,
    });
    expect(indexed.unpricedTokens).toBe(120);
    expect(indexed.sessions).toBe(1);
  });

  it('a resumed subagent card shows the same usage live, from pi\'s totals, as its segment reads back after a reload', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-agent-parity-')));
    made.push(root);
    const sessionDir = path.join(root, 'subagents');

    // The launch run, which an earlier card showed.
    const sm = SessionManager.create(path.join(root, 'cwd'), sessionDir);
    sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, { agentId: 'agent-1', kind: 'subagent', agentType: 'Explore', description: 'dig', prompt: 'dig in', background: false });
    sm.appendMessage({ role: 'user', content: 'dig in', timestamp: Date.now() });
    const first = sm.appendMessage(assistant('stop', usage(1200, 300, 8000, 2000, 0.0421)));
    sm.appendUsage('cache_warm', 'anthropic', 'claude-haiku-4-5-20251001', usage(0, 1, 30_000, 0, 0.003));
    const file = sm.getSessionFile()!;

    // The resume reopens the file, and the bridge takes its baseline as it attaches.
    const session = await openPiSession(root, file, sessionDir);
    const readings: AgentUsageTotals[] = [];
    const bridge = new SubagentStreamBridge({
      parentToolUseId: 'tc-resume', agentId: 'agent-1', agentType: 'Explore', isBackground: false,
      getSessionId: () => 'parent', postMessage: () => {}, onUsage: (u) => readings.push(u),
    });
    bridge.attach(session);
    const before = session.getSessionStats();
    session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: 'tc-resume' });
    session.sessionManager.appendMessage({ role: 'user', content: 'continue', timestamp: Date.now() });

    // pi's own event path: listeners first, then the append, so the bridge reads one microtask later.
    const handle = (session as unknown as { _handleAgentEvent: (event: unknown) => Promise<void> })._handleAgentEvent;
    await handle({ type: 'message_end', message: assistant('toolUse', usage(400, 120, 9000, 300, 0.0077)) });
    await Promise.resolve();
    expect(readings.at(-1)).toMatchObject({ totalInputTokens: 400, totalOutputTokens: 120, cacheReadTokens: 9000, cacheCreationTokens: 300 });

    // Spend that raises no message: a compaction and a cache warm, read when the run settles.
    session.sessionManager.appendCompaction('summary', first, 20_000, undefined, false, usage(20_000, 800, 0, 0, 0.072));
    session.sessionManager.appendUsage('cache_warm', 'anthropic', 'claude-haiku-4-5-20251001', usage(0, 1, 12_000, 0, 0.0012));
    await handle({ type: 'message_end', message: assistant('stop', usage(100, 40, 12_000, 0, 0.0052)) });
    bridge.settleUsage();

    const live = readings.at(-1)!;
    const after = session.getSessionStats();
    const [, resumed] = (await readAgentFile(file))!.segments;
    const { costUsd: reloadCost, ...reloadTokens } = resumed!.usage;
    const { costUsd: liveCost, ...liveTokens } = live;
    expect(liveTokens).toEqual(reloadTokens);
    expect(liveCost).toBeCloseTo(reloadCost, 12);
    expect(liveTokens).toEqual({
      totalInputTokens: after.tokens.input - before.tokens.input,
      totalOutputTokens: after.tokens.output - before.tokens.output,
      cacheReadTokens: after.tokens.cacheRead - before.tokens.cacheRead,
      cacheCreationTokens: after.tokens.cacheWrite - before.tokens.cacheWrite,
    });
    expect(liveCost).toBeCloseTo(0.0077 + 0.072 + 0.0012 + 0.0052, 12);
  });
});
