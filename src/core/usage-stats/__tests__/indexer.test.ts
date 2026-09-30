import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NO_PROJECT_KEY } from '../../../shared/types/usage-stats';
import { sumUsage, type AccountingEntry } from '../../../shared/usage-accounting';
import {
  subagentsDir,
  teamCheckpointPath,
  teamEventLogPath,
  teamMembersDir,
  teamMemberSessionId,
} from '../../pi-session/agent-records';
import { DAMOCLES_AGENT_LAUNCH_ENTRY } from '../../pi-session/session-store/constants';
import { openUsageDatabase, type UsageDatabase } from '../database';
import { classifySessionPath, indexUsage, projectKeyOf, type IndexUsageSummary } from '../indexer';
import { loadRates, queryTotals } from '../queries';
import type { UsageStatsModel, UsageStatsProgress } from '../worker-protocol';

const MODELS: UsageStatsModel[] = [
  { key: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', inputRatePerToken: 3e-6 },
  { key: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', inputRatePerToken: 1e-6 },
  { key: 'openai/gpt-5', label: 'GPT-5', inputRatePerToken: 1.25e-6 },
];

const CWD = path.resolve('/work/repo');
const T0 = Date.parse('2025-06-10T09:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

// ---- pi session file lines ----------------------------------------------------------

type Line = Record<string, unknown>;

function usage(cost: number, tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {}) {
  const input = tokens.input ?? 100;
  const output = tokens.output ?? 50;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  return {
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

const header = (id: string, timestamp: string, cwd = CWD, parentSession?: string): Line => ({
  type: 'session', version: 3, id, timestamp, cwd, ...(parentSession ? { parentSession } : {}),
});

function assistant(id: string, timestamp: string, cost: number, opts: { stopReason?: string; provider?: string; model?: string } = {}): Line {
  return {
    type: 'message', id, parentId: null, timestamp,
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages',
      provider: opts.provider ?? 'anthropic', model: opts.model ?? 'claude-sonnet-4-5',
      usage: usage(cost), stopReason: opts.stopReason ?? 'stop', timestamp: Date.parse(timestamp),
    },
  };
}

const userMessage = (id: string, timestamp: string): Line => ({
  type: 'message', id, parentId: null, timestamp, message: { role: 'user', content: 'go', timestamp: Date.parse(timestamp) },
});

const title = (id: string, timestamp: string, name: string): Line => ({ type: 'session_info', id, parentId: null, timestamp, name });

const subagentLaunch = (id: string, timestamp: string, agentType: string): Line => ({
  type: 'custom', customType: DAMOCLES_AGENT_LAUNCH_ENTRY, id, parentId: null, timestamp,
  data: { agentId: 'agent-1', kind: 'subagent', agentType, description: 'd', prompt: 'p', background: false },
});

const memberLaunch = (id: string, timestamp: string, role: string): Line => ({
  type: 'custom', customType: DAMOCLES_AGENT_LAUNCH_ENTRY, id, parentId: null, timestamp,
  data: { agentId: 'member-1', kind: 'team-member', teamId: 'team-1', attempt: 0, memberName: 'Ada', role, task: 't' },
});

function ledgerRecord(id: string, timestamp: string, purpose: string, cost: number, where: { cwd: string | null; sessionId: string | null }, model = 'claude-haiku-4-5'): Line {
  return {
    v: 1, type: 'subcall', id, timestamp, purpose, provider: 'anthropic', model, stopReason: 'stop',
    cwd: where.cwd, sessionId: where.sessionId, usage: usage(cost),
  };
}

const jsonl = (lines: readonly Line[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

function writeLines(file: string, lines: readonly Line[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(lines));
}

function appendLines(file: string, lines: readonly Line[]): void {
  fs.appendFileSync(file, jsonl(lines));
}

// ---- environment ---------------------------------------------------------------------

interface Env {
  root: string;
  sessionsDir: string;
  slugDir: string;
  ledgerPath: string;
  db: UsageDatabase;
  logs: string[];
}

let env: Env;

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-usage-index-')));
  const sessionsDir = path.join(root, 'agent', 'sessions');
  const logs: string[] = [];
  env = {
    root,
    sessionsDir,
    slugDir: path.join(sessionsDir, '--work-repo--'),
    ledgerPath: path.join(root, 'usage', 'subcalls.jsonl'),
    db: openUsageDatabase(path.join(root, 'usage', 'usage.db'), (m) => logs.push(m)),
    logs,
  };
});

afterEach(() => {
  env.db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

const mainPath = (sessionId: string, fileTs = '2025-06-10T09-00-00-000Z'): string => path.join(env.slugDir, `${fileTs}_${sessionId}.jsonl`);

async function scan(onProgress?: (p: UsageStatsProgress) => void, models: readonly UsageStatsModel[] = MODELS): Promise<IndexUsageSummary> {
  const summary = await indexUsage({
    db: env.db, sessionsDir: env.sessionsDir, ledgerPath: env.ledgerPath, models, log: (m) => env.logs.push(m),
    ...(onProgress ? { onProgress } : {}),
  });
  expect(summary.filesFailed, env.logs.join('\n')).toBe(0);
  return summary;
}

interface Row {
  key: string;
  sessionId: string | null;
  agentSessionId: string | null;
  origin: string;
  kind: string;
  detail: string | null;
  modelKey: string | null;
  projectKey: string;
  cost: number;
  stopReason: string | null;
  path: string;
}

function rows(): Row[] {
  return env.db.prepare(`SELECT e.entry_key AS key, e.session_id AS sessionId, e.agent_session_id AS agentSessionId, e.origin, e.kind,
      e.detail, e.model_key AS modelKey, e.project_key AS projectKey, e.cost_total AS cost, e.stop_reason AS stopReason, f.path AS path
    FROM entries e JOIN files f ON f.file_id = e.file_id ORDER BY e.entry_key`).all() as unknown as Row[];
}

const rowById = (id: string): Row => {
  const row = rows().find((r) => r.key.startsWith(`${id}|`));
  if (!row) throw new Error(`no row for entry ${id}`);
  return row;
};

function fileRow(file: string): { byte_offset: number; size: number; missing: number; parse_errors: number } | undefined {
  return env.db.prepare('SELECT byte_offset, size, missing, parse_errors FROM files WHERE path = ?').get(file) as never;
}

function totals() {
  loadRates(env.db, MODELS);
  return queryTotals(env.db, { startMs: 0, endMs: Number.MAX_SAFE_INTEGER }, { modelKeys: [], projectKeys: [] }, 'UTC');
}

// ---- tests ---------------------------------------------------------------------------

describe('classifySessionPath', () => {
  // Pinned against the builders the agent runtime writes with, so a layout change there fails here.
  const sessionsDir = path.resolve('/damocles/pi/agent/sessions');
  const slug = path.join(sessionsDir, '--work-repo--');

  it('classifies main, subagent and team-member files by the agent-records.ts layout', () => {
    expect(classifySessionPath(sessionsDir, path.join(slug, '2025-06-10T09-00-00-000Z_sess-p.jsonl'))).toEqual({ kind: 'main' });
    expect(classifySessionPath(sessionsDir, path.join(subagentsDir(slug, 'sess-p'), '2025-06-10T09-01-00-000Z_agent-1.jsonl')))
      .toEqual({ kind: 'subagent', parentSessionId: 'sess-p' });
    const memberFile = path.join(teamMembersDir(slug, 'sess-p', 'team-1'), `2025-06-10T09-02-00-000Z_${teamMemberSessionId('member-1', 2)}.jsonl`);
    expect(classifySessionPath(sessionsDir, memberFile)).toEqual({ kind: 'team', parentSessionId: 'sess-p', teamId: 'team-1' });
  });

  it('skips team event logs, checkpoints and anything outside the layout', () => {
    expect(classifySessionPath(sessionsDir, teamEventLogPath(slug, 'sess-p', 'team-1'))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, teamCheckpointPath(slug, 'sess-p', 'team-1', 1_750_000_000_000))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, path.join(slug, 'notes.json'))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, path.join(slug, 'sess-p', 'stray.jsonl'))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, path.join(sessionsDir, 'top-level.jsonl'))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, path.resolve('/elsewhere/--work-repo--/x_sess.jsonl'))).toEqual({ kind: 'skip' });
    expect(classifySessionPath(sessionsDir, sessionsDir)).toEqual({ kind: 'skip' });
  });
});

describe('indexUsage layout', () => {
  it('attributes main, subagent and team files to the top-level session with agent type and role as detail', async () => {
    const main = mainPath('sess-p');
    writeLines(main, [header('sess-p', at(0)), userMessage('00000001', at(0.5)), assistant('a0000001', at(1), 0.1)]);
    const subagent = path.join(subagentsDir(env.slugDir, 'sess-p'), '2025-06-10T09-02-00-000Z_agent-s.jsonl');
    writeLines(subagent, [header('agent-s', at(2)), subagentLaunch('c0000001', at(2), 'Explore'), assistant('b0000001', at(3), 0.2)]);
    const member = path.join(teamMembersDir(env.slugDir, 'sess-p', 'team-1'), `2025-06-10T09-04-00-000Z_${teamMemberSessionId('member-1', 0)}.jsonl`);
    writeLines(member, [header('member-1.a0', at(4)), memberLaunch('c0000002', at(4), 'backend-architect'), assistant('b0000002', at(5), 0.4)]);
    // Usage-shaped lines in a team event log and a checkpoint must never be indexed.
    writeLines(teamEventLogPath(env.slugDir, 'sess-p', 'team-1'), [assistant('e0000001', at(6), 9), { type: 'agent-completed', usage: usage(9) }]);
    const checkpoint = teamCheckpointPath(env.slugDir, 'sess-p', 'team-1', T0 + 7 * 60_000);
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(checkpoint, JSON.stringify(assistant('e0000002', at(7), 9)));

    await scan();

    expect(rows().map((r) => ({ id: r.key.split('|')[0], sessionId: r.sessionId, agentSessionId: r.agentSessionId, origin: r.origin, detail: r.detail }))).toEqual([
      { id: 'a0000001', sessionId: 'sess-p', agentSessionId: null, origin: 'main', detail: null },
      { id: 'b0000001', sessionId: 'sess-p', agentSessionId: 'agent-s', origin: 'subagent', detail: 'Explore' },
      { id: 'b0000002', sessionId: 'sess-p', agentSessionId: 'member-1.a0', origin: 'team', detail: 'backend-architect' },
    ]);
    expect(rowById('a0000001').key).toBe(`a0000001|${at(1)}`);
    const indexedPaths = (env.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);
    expect(indexedPaths.sort()).toEqual([main, member, subagent].sort());
    expect(env.db.prepare('SELECT session_id FROM sessions').all()).toEqual([{ session_id: 'sess-p' }]);
    const t = totals();
    expect(t.cost).toBeCloseTo(0.7, 10);
    expect(t.sessions).toBe(1);
    expect(t.requests).toBe(3);
  });

  it('reports progress from zero to every file', async () => {
    writeLines(mainPath('sess-p'), [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    writeLines(mainPath('sess-q', '2025-06-10T10-00-00-000Z'), [header('sess-q', at(60)), assistant('a0000002', at(61), 0.1)]);
    writeLines(env.ledgerPath, [ledgerRecord('11111111-0000-0000-0000-000000000001', at(2), 'btw', 0.01, { cwd: null, sessionId: null })]);
    const seen: UsageStatsProgress[] = [];
    const summary = await scan((p) => seen.push(p));
    expect(summary.filesTotal).toBe(3);
    expect(seen[0]).toEqual({ filesDone: 0, filesTotal: 3 });
    expect(seen.at(-1)).toEqual({ filesDone: 3, filesTotal: 3 });
  });
});

describe('indexUsage incremental reads', () => {
  it('reads only what was appended', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    await scan();
    appendLines(file, [assistant('a0000002', at(2), 0.2)]);
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'a0000002']);
    expect(totals().cost).toBeCloseTo(0.3, 10);
    expect(fileRow(file)).toMatchObject({ byte_offset: fs.statSync(file).size, parse_errors: 0 });
  });

  it('leaves a trailing partial line for the next scan, then picks it up', async () => {
    const file = mainPath('sess-p');
    const complete = jsonl([header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    const pending = JSON.stringify(assistant('a0000002', at(2), 0.2));
    const cut = Math.floor(pending.length / 2);
    fs.mkdirSync(env.slugDir, { recursive: true });
    fs.writeFileSync(file, complete + pending.slice(0, cut));

    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001']);
    expect(fileRow(file)).toMatchObject({ byte_offset: Buffer.byteLength(complete), parse_errors: 0 });

    fs.appendFileSync(file, `${pending.slice(cut)}\n`);
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'a0000002']);
    expect(totals().cost).toBeCloseTo(0.3, 10);
    expect(fileRow(file)).toMatchObject({ parse_errors: 0 });
  });

  it('resumes from the stored offset when only the mtime changed', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    await scan();
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    await scan();
    expect(rows()).toHaveLength(1);
    expect(totals()).toMatchObject({ requests: 1 });
    expect(totals().cost).toBeCloseTo(0.1, 10);
  });

  it('reparses a shrunk file from byte 0, keeping old rows and counting nothing twice', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1), assistant('a0000002', at(2), 0.2), assistant('a0000003', at(3), 0.4)]);
    await scan();
    const before = fs.statSync(file).size;
    // Rewritten shorter, with an entry the old offset has already passed.
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1), assistant('d0000004', at(4), 0.8)]);
    expect(fs.statSync(file).size).toBeLessThan(before);
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'a0000002', 'a0000003', 'd0000004']);
    expect(totals().cost).toBeCloseTo(1.5, 10);
    expect(fileRow(file)).toMatchObject({ byte_offset: fs.statSync(file).size, parse_errors: 0 });

    // Idempotent: the same rewrite scanned again (new mtime, same bytes) adds nothing.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    await scan();
    expect(rows()).toHaveLength(4);
    expect(totals().cost).toBeCloseTo(1.5, 10);
  });

  it('reparses from byte 0 when the bytes before the stored offset changed', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1), assistant('a0000002', at(2), 0.2)]);
    await scan();
    const offset = fileRow(file)!.byte_offset;
    // Same prefix length or longer, different tail: resuming at the old offset would land mid-line.
    writeLines(file, [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1), assistant('x0000009', at(2.5), 1.6, { model: 'claude-sonnet-4-5-long-model-name' }), assistant('e0000005', at(5), 3.2)]);
    expect(fs.statSync(file).size).toBeGreaterThan(offset);
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'a0000002', 'e0000005', 'x0000009']);
    expect(totals().cost).toBeCloseTo(0.1 + 0.2 + 1.6 + 3.2, 10);
    expect(fileRow(file)).toMatchObject({ parse_errors: 0 });
  });
});

describe('indexUsage fork dedupe', () => {
  // P is the original conversation; F forked it later. Both carry P's entries a1, a2 verbatim, and F's
  // folder carries a copy of P's subagent file.
  const P = 'sess-p';
  const F = 'sess-f';

  function writeOriginal(): { main: string; subagent: string } {
    const main = mainPath(P, '2025-06-10T09-00-00-000Z');
    writeLines(main, [header(P, at(0)), userMessage('00000001', at(0.5)), assistant('a0000001', at(1), 0.1), assistant('a0000002', at(2), 0.2), title('10000001', at(2.1), 'Original')]);
    const subagent = path.join(subagentsDir(env.slugDir, P), '2025-06-10T09-01-30-000Z_agent-s.jsonl');
    writeLines(subagent, [header('agent-s', at(1.5)), subagentLaunch('c0000001', at(1.5), 'Explore'), assistant('b0000001', at(1.6), 0.4)]);
    return { main, subagent };
  }

  /** `verbatim`: the subagent file byte-copied (same header id and timestamp). `pi`: re-headered as createBranchedSession does. */
  function writeFork(subagentCopy: 'verbatim' | 'pi', originalMain: string): { main: string; subagent: string } {
    const main = mainPath(F, '2025-06-10T09-10-00-000Z');
    writeLines(main, [
      header(F, at(10), CWD, originalMain), userMessage('00000001', at(0.5)), assistant('a0000001', at(1), 0.1), assistant('a0000002', at(2), 0.2),
      assistant('f0000001', at(11), 0.8),
    ]);
    const subagent = path.join(subagentsDir(env.slugDir, F), '2025-06-10T09-10-00-001Z_agent-s.jsonl');
    const subagentHeader = subagentCopy === 'verbatim' ? header('agent-s', at(1.5)) : header('agent-s2', at(10));
    writeLines(subagent, [subagentHeader, subagentLaunch('c0000001', at(1.5), 'Explore'), assistant('b0000001', at(1.6), 0.4)]);
    return { main, subagent };
  }

  function attribution(): Array<{ id: string; sessionId: string | null; origin: string; path: string }> {
    return rows().map((r) => ({ id: r.key.split('|')[0]!, sessionId: r.sessionId, origin: r.origin, path: path.relative(env.sessionsDir, r.path) }));
  }

  describe.each(['verbatim', 'pi'] as const)('with a %s subagent copy', (subagentCopy) => {
    async function run(order: 'original-first' | 'fork-first' | 'together') {
      const originalMain = mainPath(P, '2025-06-10T09-00-00-000Z');
      if (order === 'original-first') {
        writeOriginal();
        await scan();
        writeFork(subagentCopy, originalMain);
        await scan();
      } else if (order === 'fork-first') {
        writeFork(subagentCopy, originalMain);
        await scan();
        writeOriginal();
        await scan();
      } else {
        writeOriginal();
        writeFork(subagentCopy, originalMain);
        await scan();
      }
      return attribution();
    }

    it.each(['original-first', 'fork-first', 'together'] as const)('counts copied entries once, under the oldest session (%s)', async (order) => {
      const result = await run(order);
      const rel = (p: string) => path.relative(env.sessionsDir, p);
      const original = { main: rel(mainPath(P, '2025-06-10T09-00-00-000Z')), subagent: rel(path.join(subagentsDir(env.slugDir, P), '2025-06-10T09-01-30-000Z_agent-s.jsonl')) };
      expect(result).toEqual([
        { id: 'a0000001', sessionId: P, origin: 'main', path: original.main },
        { id: 'a0000002', sessionId: P, origin: 'main', path: original.main },
        { id: 'b0000001', sessionId: P, origin: 'subagent', path: original.subagent },
        { id: 'f0000001', sessionId: F, origin: 'main', path: rel(mainPath(F, '2025-06-10T09-10-00-000Z')) },
      ]);
      const t = totals();
      expect(t.cost).toBeCloseTo(0.1 + 0.2 + 0.4 + 0.8, 10);
      expect(t.requests).toBe(4);
      expect(t.sessions).toBe(2);
    });
  });
});

describe('indexUsage nested file before its parent', () => {
  it('re-anchors a nested file indexed first to the parent session once the parent appears', async () => {
    const OTHER_CWD = path.resolve('/work/elsewhere');
    const subagent = path.join(subagentsDir(env.slugDir, 'sess-p'), '2025-06-10T09-05-00-000Z_agent-s.jsonl');
    writeLines(subagent, [header('agent-s', at(5), OTHER_CWD), subagentLaunch('c0000001', at(5), 'Explore'), assistant('b0000001', at(6), 0.4)]);
    await scan();
    const anchor = () => env.db.prepare(`SELECT e.session_started_ms AS startedMs, e.project_key AS projectKey,
      f.session_started_ms AS fileStartedMs, f.project_key AS fileProjectKey FROM entries e JOIN files f ON f.file_id = e.file_id`).all();
    // No parent row yet: the nested file falls back to its own header.
    expect(anchor()).toEqual([{ startedMs: T0 + 5 * 60_000, projectKey: projectKeyOf(OTHER_CWD), fileStartedMs: T0 + 5 * 60_000, fileProjectKey: projectKeyOf(OTHER_CWD) }]);

    writeLines(mainPath('sess-p'), [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    await scan();
    const parentAnchor = { startedMs: T0, projectKey: projectKeyOf(CWD), fileStartedMs: T0, fileProjectKey: projectKeyOf(CWD) };
    expect(anchor()).toEqual([parentAnchor, parentAnchor]);
    expect(rowById('b0000001')).toMatchObject({ sessionId: 'sess-p', origin: 'subagent', projectKey: projectKeyOf(CWD) });
  });
});

describe('indexUsage model registry changes', () => {
  const DATED = 'claude-haiku-4-5-20251001';
  const withoutBase = MODELS.filter((m) => m.key !== 'anthropic/claude-haiku-4-5');

  it('re-keys rows indexed under an older registry, so filters, breakdowns and rates agree', async () => {
    writeLines(env.ledgerPath, [ledgerRecord('11111111-0000-0000-0000-000000000001', at(1), 'btw', 0.02, { cwd: null, sessionId: null }, DATED)]);
    await scan(undefined, withoutBase);
    expect(rows().map((r) => r.modelKey)).toEqual([`anthropic/${DATED}`]);

    // The registry gains the base id; the ledger is unchanged, so its row is never re-read.
    writeLines(mainPath('sess-p'), [header('sess-p', at(0)), assistant('a0000002', at(2), 0.1, { model: DATED })]);
    await scan();
    expect(rows().map((r) => r.modelKey)).toEqual(['anthropic/claude-haiku-4-5', 'anthropic/claude-haiku-4-5']);
    loadRates(env.db, MODELS);
    const filtered = queryTotals(env.db, { startMs: 0, endMs: Number.MAX_SAFE_INTEGER }, { modelKeys: ['anthropic/claude-haiku-4-5'], projectKeys: [] }, 'UTC');
    expect(filtered.cost).toBeCloseTo(0.12, 10);

    // And back when the registry loses it again.
    await scan(undefined, withoutBase);
    expect(new Set(rows().map((r) => r.modelKey))).toEqual(new Set([`anthropic/${DATED}`]));
  });
});

describe('indexUsage while another window holds the write lock', () => {
  it('still finishes a scan when the tail steps are busy, and completes them on the next scan', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), title('10000001', at(0.1), 'Gone soon'), assistant('a0000001', at(1), 0.3)]);
    await scan();
    const indexedAt = env.db.prepare("SELECT value FROM meta WHERE key = 'indexed_at_ms'").get();
    fs.rmSync(file);

    const other = openUsageDatabase(path.join(env.root, 'usage', 'usage.db'), () => {});
    env.db.exec('PRAGMA busy_timeout = 50');
    other.exec('BEGIN IMMEDIATE');
    try {
      await scan();
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(fileRow(file)).toMatchObject({ missing: 0 });
    expect(env.db.prepare("SELECT value FROM meta WHERE key = 'indexed_at_ms'").get()).toEqual(indexedAt);
    expect(env.logs.join('\n')).toMatch(/Could not mark vanished files missing; retrying on the next scan/);

    await scan();
    expect(fileRow(file)).toMatchObject({ missing: 1 });
    expect(env.db.prepare('SELECT title, missing FROM sessions WHERE session_id = ?').get('sess-p')).toEqual({ title: null, missing: 1 });
  });
});

describe('indexUsage deleted conversations', () => {
  it('keeps the spend of a vanished file, marks its conversation missing and clears its title', async () => {
    const file = mainPath('sess-p');
    writeLines(file, [header('sess-p', at(0)), title('10000001', at(0.1), 'Refactor the parser'), assistant('a0000001', at(1), 0.3)]);
    const subagent = path.join(subagentsDir(env.slugDir, 'sess-p'), '2025-06-10T09-02-00-000Z_agent-s.jsonl');
    writeLines(subagent, [header('agent-s', at(2)), subagentLaunch('c0000001', at(2), 'Explore'), assistant('b0000001', at(3), 0.5)]);
    await scan();
    expect(env.db.prepare('SELECT title, missing FROM sessions WHERE session_id = ?').get('sess-p')).toEqual({ title: 'Refactor the parser', missing: 0 });

    fs.rmSync(path.join(env.slugDir, 'sess-p'), { recursive: true });
    fs.rmSync(file);
    await scan();

    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'b0000001']);
    expect(env.db.prepare('SELECT title, missing FROM sessions WHERE session_id = ?').get('sess-p')).toEqual({ title: null, missing: 1 });
    expect(fileRow(file)).toMatchObject({ missing: 1 });
    expect(fileRow(subagent)).toMatchObject({ missing: 1 });
    const t = totals();
    expect(t.cost).toBeCloseTo(0.8, 10);
    expect(t.sessions).toBe(1);
  });
});

describe('indexUsage with a second window on the same index', () => {
  it('never marks missing a file that another window indexed after this scan listed the directory', async () => {
    const other = openUsageDatabase(path.join(env.root, 'usage', 'usage.db'), (m) => env.logs.push(m));
    try {
      for (const [i, id] of ['sess-a', 'sess-b', 'sess-c'].entries()) {
        writeLines(mainPath(id, `2025-06-10T0${i}-00-00-000Z`), [header(id, at(i)), assistant(`a000000${i}`, at(i + 0.5), 0.1)]);
      }
      await scan();
      const late = mainPath('sess-z', '2025-06-10T12-00-00-000Z');
      let otherScan: Promise<IndexUsageSummary> | undefined;
      // This scan has listed the directory; the late file appears and the other window indexes it at once.
      const mine = scan((p) => {
        if (p.filesDone !== 0 || otherScan) return;
        writeLines(late, [header('sess-z', at(180)), title('10000009', at(180.1), 'Late conversation'), assistant('z0000001', at(181), 0.2)]);
        otherScan = indexUsage({ db: other, sessionsDir: env.sessionsDir, ledgerPath: env.ledgerPath, models: MODELS, log: (m) => env.logs.push(m) });
      });
      await mine;
      await otherScan;
      expect(fileRow(late)).toMatchObject({ missing: 0 });
      expect(env.db.prepare('SELECT title, missing FROM sessions WHERE session_id = ?').get('sess-z')).toEqual({ title: 'Late conversation', missing: 0 });
    } finally {
      other.close();
    }
  });
});

describe('indexUsage sub-call ledger', () => {
  it('indexes ledger rows as background with the purpose as detail, and cwd:null under no project', async () => {
    writeLines(env.ledgerPath, [
      ledgerRecord('11111111-0000-0000-0000-000000000001', at(1), 'session-title', 0.01, { cwd: CWD, sessionId: 'sess-p' }, 'claude-haiku-4-5-20251001'),
      ledgerRecord('11111111-0000-0000-0000-000000000002', at(2), 'btw', 0.02, { cwd: null, sessionId: null }),
    ]);
    await scan();
    appendLines(env.ledgerPath, [ledgerRecord('11111111-0000-0000-0000-000000000003', at(3), 'memory-extract', 0.04, { cwd: CWD, sessionId: null })]);
    await scan();

    expect(rows().map((r) => ({ origin: r.origin, kind: r.kind, detail: r.detail, sessionId: r.sessionId, projectKey: r.projectKey, modelKey: r.modelKey }))).toEqual([
      { origin: 'background', kind: 'subcall', detail: 'session-title', sessionId: 'sess-p', projectKey: projectKeyOf(CWD), modelKey: 'anthropic/claude-haiku-4-5' },
      { origin: 'background', kind: 'subcall', detail: 'btw', sessionId: null, projectKey: NO_PROJECT_KEY, modelKey: 'anthropic/claude-haiku-4-5' },
      { origin: 'background', kind: 'subcall', detail: 'memory-extract', sessionId: null, projectKey: projectKeyOf(CWD), modelKey: 'anthropic/claude-haiku-4-5' },
    ]);
    expect(env.db.prepare('SELECT cwd FROM projects WHERE project_key = ?').get(NO_PROJECT_KEY)).toEqual({ cwd: null });
    expect(totals().cost).toBeCloseTo(0.07, 10);
    expect(fileRow(env.ledgerPath)).toMatchObject({ parse_errors: 0, missing: 0 });
  });

  it('counts a malformed ledger line and keeps indexing', async () => {
    fs.mkdirSync(path.dirname(env.ledgerPath), { recursive: true });
    fs.writeFileSync(env.ledgerPath, [
      '{"v":1,"type":"subcall","usage":{"input":',
      JSON.stringify(ledgerRecord('11111111-0000-0000-0000-000000000001', at(1), 'btw', 0.02, { cwd: null, sessionId: null })),
      '',
    ].join('\n'));
    await scan();
    expect(rows()).toHaveLength(1);
    expect(fileRow(env.ledgerPath)).toMatchObject({ parse_errors: 1 });
  });
});

describe('indexUsage entry kinds', () => {
  it('counts aborted, error, tool result, cache warm, compaction and branch summary entries by pi\'s rule', async () => {
    const lines: Line[] = [
      header('sess-p', at(0)),
      userMessage('00000001', at(0.1)),
      assistant('a0000001', at(1), 0.01),
      assistant('a0000002', at(2), 0.02, { stopReason: 'aborted' }),
      assistant('a0000003', at(3), 0.04, { stopReason: 'error' }),
      { type: 'message', id: 'a0000004', parentId: null, timestamp: at(4), message: { role: 'toolResult', toolCallId: 't1', toolName: 'x', content: [], isError: false, usage: usage(0.08), timestamp: T0 } },
      { type: 'usage', id: 'a0000005', parentId: null, timestamp: at(5), kind: 'cache_warm', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', usage: usage(0.16) },
      { type: 'compaction', id: 'a0000006', parentId: null, timestamp: at(6), summary: 's', firstKeptEntryId: 'a0000001', tokensBefore: 1000, usage: usage(0.32) },
      { type: 'compaction', id: 'a0000007', parentId: null, timestamp: at(7), summary: 'no usage', firstKeptEntryId: 'a0000001', tokensBefore: 1000 },
      { type: 'model_change', id: 'a0000008', parentId: null, timestamp: at(8), provider: 'openai', modelId: 'gpt-5' },
      { type: 'branch_summary', id: 'a0000009', parentId: null, timestamp: at(9), fromId: 'a0000001', summary: 's', usage: usage(0.64) },
    ];
    writeLines(mainPath('sess-p'), lines);
    await scan();

    expect(rows().map((r) => ({ id: r.key.split('|')[0], kind: r.kind, stopReason: r.stopReason, modelKey: r.modelKey }))).toEqual([
      { id: 'a0000001', kind: 'assistant', stopReason: 'stop', modelKey: 'anthropic/claude-sonnet-4-5' },
      { id: 'a0000002', kind: 'assistant', stopReason: 'aborted', modelKey: 'anthropic/claude-sonnet-4-5' },
      { id: 'a0000003', kind: 'assistant', stopReason: 'error', modelKey: 'anthropic/claude-sonnet-4-5' },
      { id: 'a0000004', kind: 'tool_result', stopReason: null, modelKey: 'anthropic/claude-sonnet-4-5' },
      // The cache warmer records the dated response model; it maps to the registry's base id.
      { id: 'a0000005', kind: 'usage:cache_warm', stopReason: null, modelKey: 'anthropic/claude-haiku-4-5' },
      // Summaries carry no model and take the file's latest model.
      { id: 'a0000006', kind: 'compaction', stopReason: null, modelKey: 'anthropic/claude-sonnet-4-5' },
      { id: 'a0000009', kind: 'branch_summary', stopReason: null, modelKey: 'openai/gpt-5' },
    ]);
    const expected = sumUsage(lines as AccountingEntry[]);
    const t = totals();
    expect(t.cost).toBeCloseTo(expected.cost, 10);
    expect({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite })
      .toEqual({ input: expected.input, output: expected.output, cacheRead: expected.cacheRead, cacheWrite: expected.cacheWrite });
    expect(t.requests).toBe(7);
  });
});

describe('indexUsage malformed input', () => {
  it('counts malformed usage lines as parse errors without throwing and indexes the rest', async () => {
    const file = mainPath('sess-p');
    fs.mkdirSync(env.slugDir, { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify(header('sess-p', at(0))),
      JSON.stringify(assistant('a0000001', at(1), 0.1)),
      '{"type":"message","id":"a0000002","message":{"role":"assistant","usage":{"input":1',
      // Bills usage but has no id to key it.
      JSON.stringify({ ...assistant('a0000003', at(3), 9), id: undefined }),
      // No marker, so it is skipped unparsed rather than counted.
      'plain garbage',
      JSON.stringify(assistant('a0000004', at(4), 0.2)),
      '',
    ].join('\n'));
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001', 'a0000004']);
    expect(fileRow(file)).toMatchObject({ parse_errors: 2 });
    expect(totals().cost).toBeCloseTo(0.3, 10);
  });

  it('indexes nothing from a file whose first line is not a header, and still scans the others', async () => {
    const broken = mainPath('sess-x', '2025-06-10T08-00-00-000Z');
    fs.mkdirSync(env.slugDir, { recursive: true });
    fs.writeFileSync(broken, `{"type":"session","id":\n${JSON.stringify(assistant('a0000009', at(1), 5))}\n`);
    writeLines(mainPath('sess-p'), [header('sess-p', at(0)), assistant('a0000001', at(1), 0.1)]);
    await scan();
    expect(rows().map((r) => r.key.split('|')[0])).toEqual(['a0000001']);
    expect(fileRow(broken)!.parse_errors).toBeGreaterThanOrEqual(1);
  });
});

describe('indexUsage project keys', () => {
  it.runIf(process.platform === 'win32')('resolves the header cwd and lowercases it on win32', async () => {
    writeLines(mainPath('sess-p'), [header('sess-p', at(0), 'C:\\Work\\Repo\\sub\\..'), assistant('a0000001', at(1), 0.1)]);
    writeLines(mainPath('sess-q', '2025-06-10T10-00-00-000Z'), [header('sess-q', at(60), 'c:\\work\\REPO\\'), assistant('a0000002', at(61), 0.1)]);
    await scan();
    expect(new Set(rows().map((r) => r.projectKey))).toEqual(new Set(['c:\\work\\repo']));
    expect(projectKeyOf('C:\\Work\\Repo\\sub\\..')).toBe('c:\\work\\repo');
  });

  it.runIf(process.platform !== 'win32')('resolves the header cwd and keeps its case off win32', async () => {
    writeLines(mainPath('sess-p'), [header('sess-p', at(0), '/Work/Repo/sub/..'), assistant('a0000001', at(1), 0.1)]);
    await scan();
    expect(rows().map((r) => r.projectKey)).toEqual(['/Work/Repo']);
  });
});
