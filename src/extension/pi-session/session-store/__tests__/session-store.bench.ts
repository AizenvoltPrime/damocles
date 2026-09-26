import { bench, describe } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { StoredSession } from '@shared/types/session';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { subagentsDir } from '../../agent-records';
import { ensurePiSessionDir } from '../session-dir';
import { listPiSessions, extractPiPromptHistory, resolvePiSessionFile } from '../reading';
import { flushSessionMetaCache, resetSessionMetaCacheMemory } from '../session-meta-cache';
import { SESSION_META_CACHE_DIR } from '../../../paths';
import { loadPiSessionHistory } from '../history-loader';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_STATUS_ENTRY } from '../constants';

// Real pi JSONL, built through pi's own SessionManager, under the hermetic test home.
const SMALL_SESSIONS = 300;
const SMALL_TURNS = 5;
const LARGE_TURNS = 400;
const SUBAGENT_EVERY = 20;
const COMPACT_AT_TURN = 200;

const CWD = path.join(os.homedir(), 'bench-workspace');

interface Fixture {
  sessionFiles: string[];
  sessions: StoredSession[];
  largeSessionId: string;
}

function filler(label: string, chars: number): string {
  const unit = `${label} lorem ipsum dolor sit amet, consectetur adipiscing elit; `;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function assistant(content: unknown[], stopReason: string): never {
  return {
    role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
    usage: {
      input: 1200, output: 400, cacheRead: 30_000, cacheWrite: 800, totalTokens: 32_400,
      cost: { input: 0.0036, output: 0.006, cacheRead: 0.009, cacheWrite: 0.003, total: 0.0216 },
    },
    stopReason, timestamp: Date.now(),
  } as never;
}

function toolResult(toolCallId: string, toolName: string, text: string, details?: unknown): never {
  return {
    role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false,
    ...(details !== undefined ? { details } : {}), timestamp: Date.now(),
  } as never;
}

function userMessage(text: string): never {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as never;
}

/** One user turn: thinking, two tool calls with ~4 KB results each, and a closing answer (~11 KB). */
function appendTurn(sm: SessionManager, turn: number): void {
  // Unique per session, as real prompts are, so the prompt-history dedupe does not collapse them.
  sm.appendMessage(userMessage(`Prompt ${turn} of ${sm.getSessionId()}: ${filler('ask', 200)}`));
  const readId = `toolu_read_${turn}`;
  const bashId = `toolu_bash_${turn}`;
  sm.appendMessage(assistant([
    { type: 'thinking', thinking: filler('think', 1000) },
    { type: 'text', text: filler('plan', 300) },
    { type: 'toolCall', id: readId, name: 'read', arguments: { path: `src/module${turn}/file.ts` } },
    { type: 'toolCall', id: bashId, name: 'bash', arguments: { command: `npm test -- module${turn}` } },
  ], 'toolUse'));
  sm.appendMessage(toolResult(readId, 'read', filler('source', 4000)));
  sm.appendMessage(toolResult(bashId, 'bash', filler('output', 4000)));
  sm.appendMessage(assistant([{ type: 'text', text: filler('answer', 1000) }], 'stop'));
}

function writeJsonl(file: string, sm: SessionManager): void {
  const lines = [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Named as pi names a session file: `<timestamp>_<id>.jsonl`. */
function writeSession(dir: string, sm: SessionManager): string {
  const stamp = sm.getHeader()!.timestamp.replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}_${sm.getSessionId()}.jsonl`);
  writeJsonl(file, sm);
  return file;
}

/** A subagent call: the parent's Agent tool call and result, its invocation entry, and the agent's own file. */
function appendSubagentCall(pi: PiCodingAgentModule, dir: string, sm: SessionManager, turn: number): void {
  const agentId = `agent${turn}`;
  const toolCallId = `toolu_agent_${turn}`;
  const prompt = filler('delegate', 500);
  sm.appendMessage(userMessage(`Delegate ${turn}`));
  sm.appendMessage(assistant([
    { type: 'toolCall', id: toolCallId, name: 'Agent', arguments: { subagent_type: 'Explore', description: `Explore ${turn}`, prompt } },
  ], 'toolUse'));
  sm.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: agentId, toolCallId, resume: false });
  sm.appendMessage(toolResult(toolCallId, 'Agent', filler('agent-result', 1500), { agentId, status: 'completed' }));
  sm.appendMessage(assistant([{ type: 'text', text: filler('after-agent', 500) }], 'stop'));

  const agent = pi.SessionManager.inMemory(CWD);
  agent.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, {
    agentId, kind: 'subagent', agentType: 'Explore', description: `Explore ${turn}`, prompt, background: false,
  });
  for (let t = 0; t < 3; t++) appendTurn(agent, t);
  agent.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'completed', result: filler('agent-result', 1500) });
  const agentDir = subagentsDir(dir, sm.getSessionId());
  fs.mkdirSync(agentDir, { recursive: true });
  writeJsonl(path.join(agentDir, `${agentId}.jsonl`), agent);
}

async function buildFixture(): Promise<Fixture> {
  const home = path.resolve(os.homedir()).toLowerCase();
  if (!home.startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
    throw new Error(`session-store bench needs the hermetic test home, got ${home}`);
  }
  const pi = await initPiLoader();
  if (!pi) throw new Error('pi failed to load');
  const dir = ensurePiSessionDir(CWD);

  const sessionFiles: string[] = [];
  for (let s = 0; s < SMALL_SESSIONS; s++) {
    const sm = pi.SessionManager.inMemory(CWD);
    for (let t = 0; t < SMALL_TURNS; t++) appendTurn(sm, t);
    sessionFiles.push(writeSession(dir, sm));
  }

  const large = pi.SessionManager.inMemory(CWD);
  let firstKept: string | null = null;
  for (let t = 0; t < LARGE_TURNS; t++) {
    if (t % SUBAGENT_EVERY === SUBAGENT_EVERY - 1) appendSubagentCall(pi, dir, large, t);
    else appendTurn(large, t);
    if (t === COMPACT_AT_TURN - 10) firstKept = large.getLeafId();
    if (t === COMPACT_AT_TURN) large.appendCompaction(filler('summary', 3000), firstKept, 150_000);
  }
  large.appendSessionInfo('Large benchmark conversation');
  const largeSessionId = large.getSessionId();
  const largeFile = writeSession(dir, large);
  sessionFiles.push(largeFile);

  const sessions = await listPiSessions(CWD);
  const prompts = await extractPiPromptHistory([CWD], sessions);
  const posted: string[] = [];
  let hydratedAgents = 0;
  await loadPiSessionHistory(CWD, largeSessionId, (m) => {
    posted.push(m.type);
    if (m.type === 'assistantReplay') hydratedAgents += (m.tools ?? []).filter((t) => t.agentLaunch).length;
  });
  if (sessions.length !== sessionFiles.length || prompts.length === 0 || !posted.includes('compactBoundary') || hydratedAgents === 0) {
    throw new Error(`fixture did not load as expected: ${sessions.length} listed, ${prompts.length} prompts, posted ${posted.length}`);
  }
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  const total = sessionFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`[bench] ${sessionFiles.length} session files, ${mb(total)} MB total, large file ${mb(fs.statSync(largeFile).size)} MB, ${prompts.length} history prompts, replay posts ${posted.length} messages with ${hydratedAgents} subagent cards`);
  return { sessionFiles, sessions, largeSessionId };
}

// The benchmark runner skips beforeAll hooks, so the fixture is built while the file is collected.
const { sessions, largeSessionId } = await buildFixture();

/** No metadata anywhere: the first run after an update, or ever. */
function coldCache(): void {
  resetSessionMetaCacheMemory();
  fs.rmSync(SESSION_META_CACHE_DIR, { recursive: true, force: true });
}

// `throws` fails the run on an error; tinybench otherwise records it and reports NaN.
describe('session store', () => {
  bench('listPiSessions cold', async () => {
    coldCache();
    await listPiSessions(CWD);
  }, { iterations: 5, time: 0, throws: true });

  bench('listPiSessions warm', async () => {
    await listPiSessions(CWD);
  }, { iterations: 20, time: 0, throws: true });

  // The in-memory layer is gone and the disk cache is warm, as in a reloaded or second window.
  bench('listPiSessions new window', async () => {
    resetSessionMetaCacheMemory();
    await listPiSessions(CWD);
  }, { iterations: 20, time: 0, throws: true, setup: () => flushSessionMetaCache() });

  bench('extractPiPromptHistory cold', async () => {
    coldCache();
    await extractPiPromptHistory([CWD], sessions);
  }, { iterations: 5, time: 0, throws: true });

  bench('extractPiPromptHistory warm', async () => {
    await extractPiPromptHistory([CWD], sessions);
  }, { iterations: 5, time: 0, throws: true, setup: () => extractPiPromptHistory([CWD], sessions).then(() => undefined) });

  bench('resolvePiSessionFile, large conversation', async () => {
    await resolvePiSessionFile(CWD, largeSessionId);
  }, { iterations: 20, time: 0, throws: true, setup: () => listPiSessions(CWD).then(() => undefined) });

  bench('loadPiSessionHistory large conversation', async () => {
    await loadPiSessionHistory(CWD, largeSessionId, () => {});
  }, { iterations: 10, time: 0, throws: true });
});
