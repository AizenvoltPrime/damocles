import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildSessionProjection,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createDatabaseWrapper } from '../database';
import { setInjectionDbDirForTests } from '../injection-database';
import { InjectionManager } from '../managers/injection-manager';
import { ProfileManager } from '../managers/profile-manager';
import { MemoryWriteQueue } from '../write-queue';
import { GATE } from '../injection/gate';
import { CONTEXT_INJECTION_CUSTOM_TYPE, readLiveInjections } from '../../pi-session/live-injections';
import { splitIdeContext } from '../../../shared/ide-context';
import type { MemorySubCallRunner } from '../subcall-runner';
import type { DatabaseInstance } from '../types';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

/**
 * Replays recorded sessions through the injection engine against a COPY of the real memory store,
 * comparing the bytes the old engine recorded with what this engine would send. Opt-in:
 *   DAMOCLES_MEMORY_REPLAY=<pi sessions dir for one workspace> [DAMOCLES_MEMORY_REPLAY_N=10]
 * The store defaults to `~/.damocles/memory.v3.db` resolved from the sessions dir, because tests run
 * with a hermetic home; DAMOCLES_MEMORY_REPLAY_STORE overrides it. DAMOCLES_MEMORY_REPLAY_GATE takes a
 * JSON object of GATE overrides for calibration runs; DAMOCLES_MEMORY_REPLAY_OUT writes the report to a file.
 */
const SESSIONS_DIR = process.env['DAMOCLES_MEMORY_REPLAY'];
const SESSION_COUNT = Number(process.env['DAMOCLES_MEMORY_REPLAY_N'] ?? 10);
const REPORT = process.env['DAMOCLES_MEMORY_REPLAY_OUT'];
const STORE =
  process.env['DAMOCLES_MEMORY_REPLAY_STORE'] ??
  (SESSIONS_DIR ? path.resolve(SESSIONS_DIR, '..', '..', '..', '..', 'memory.v3.db') : '');

const noRunner: MemorySubCallRunner = { run: async () => ({ value: null }) };

function copyStore(): { db: DatabaseInstance; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-replay-'));
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(STORE + ext)) fs.copyFileSync(STORE + ext, path.join(dir, `memory.v3.db${ext}`));
  }
  const raw = new DatabaseSync(path.join(dir, 'memory.v3.db'));
  return { db: createDatabaseWrapper(raw), dir };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')
    .map(p => p.text)
    .join('\n');
}

/** The recorded Compass line and its change key, parsed from its attributes. */
function recordedCompass(content: string): { text: string; key: string } | null {
  const start = content.indexOf('<damocles_compass');
  if (start < 0) return null;
  const text = content.slice(start);
  const attr = (name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? '';
  return { text, key: [attr('state'), attr('nodes'), attr('edges'), attr('stale') ? 'stale' : '', attr('error')].join('|') };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(!SESSIONS_DIR)('injection replay on recorded sessions', () => {
  const cleanup: Array<() => void> = [];
  afterAll(() => {
    for (const fn of cleanup) fn();
  });

  it('cuts recorded injection bytes by at least 70% with p95 build time under 50 ms', async () => {
    setInjectionDbDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-replay-inj-')));
    const { db, dir } = copyStore();
    cleanup.push(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const injection = new InjectionManager(db, new ProfileManager(db, new MemoryWriteQueue(), noRunner, createFakePlatform().settings), noRunner, createFakePlatform().settings, createFakePlatform().notifications);
    cleanup.push(() => injection.closeInjectionDatabases());

    const files = fs
      .readdirSync(SESSIONS_DIR!)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR!, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, SESSION_COUNT);

    const timings: number[] = [];
    let baselineTotal = 0;
    let newTotal = 0;
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    cleanup.push(() => {
      if (REPORT) fs.writeFileSync(REPORT, `${lines.join('\n')}\n`);
      else console.log(lines.join('\n'));
    });
    const overrides = process.env['DAMOCLES_MEMORY_REPLAY_GATE'];
    if (overrides) Object.assign(GATE as Record<string, number>, JSON.parse(overrides) as Record<string, number>);
    log(`gate constants: ${JSON.stringify(GATE)}`);
    const tokensByReason: Record<string, number> = {};

    for (const { f } of files) {
      const fileEntries: FileEntry[] = parseSessionEntries(fs.readFileSync(path.join(SESSIONS_DIR!, f), 'utf8'));
      migrateSessionEntries(fileEntries);
      const header = fileEntries.find(e => e.type === 'session') as { id: string; cwd: string } | undefined;
      if (!header) continue;
      const entries = fileEntries.filter((e): e is SessionEntry => e.type !== 'session');
      const byId = new Map(entries.map(e => [e.id, e]));
      const injectionsByParent = new Map<string, SessionEntry & { type: 'custom_message' }>();
      let baseline = 0;
      for (const e of entries) {
        if (e.type !== 'custom_message' || e.customType !== CONTEXT_INJECTION_CUSTOM_TYPE) continue;
        baseline += Buffer.byteLength(textOf(e.content));
        if (e.parentId) injectionsByParent.set(e.parentId, e);
      }

      let sessionNew = 0;
      let promptIndex = 0;
      log(`\n=== ${f} (workspace ${header.cwd})`);
      for (const e of entries) {
        if (e.type !== 'message' || e.message.role !== 'user') continue;
        const recorded = injectionsByParent.get(e.id);
        if (!recorded) continue;
        const compass = recordedCompass(textOf(recorded.content));
        recorded.content = '';
        delete recorded.details;

        const live = readLiveInjections(buildSessionProjection(entries, e.parentId, byId).messages);
        const { context: ide, text: prompt } = splitIdeContext(textOf(e.message.content));
        const start = performance.now();
        const result = await injection.buildInjection({
          sessionId: header.id,
          workspace: header.cwd,
          activeFile: ide?.filePath ?? null,
          prompt,
          live,
          promptIndex,
        });
        const ms = performance.now() - start;
        timings.push(ms);

        const compassText = compass && compass.key !== live.compassKey ? compass.text : '';
        const content = [result.text, compassText].filter(Boolean).join('\n\n');
        if (content) {
          recorded.content = content;
          recorded.details = {
            ...(result.details ?? { v: 1, promptIndex, memories: [], notices: [], profile: false, compassKey: null }),
            compassKey: compassText && compass ? compass.key : null,
          };
        }
        const bytes = Buffer.byteLength(content);
        sessionNew += bytes;

        const d = result.display;
        log(
          `#${promptIndex} ${ms.toFixed(1)}ms +${bytes}B tokens=${d.tokens.total} carried=${d.carried.length} ` +
            `gate=${JSON.stringify(d.gate)} profile=${d.profile.state} ` +
            `prompt="${prompt.replace(/\s+/g, ' ').slice(0, 90)}"`,
        );
        log(`   terms=${d.query.terms.slice(0, 12).join(',')} dropped=${d.query.dropped.map(x => `${x.term}:${x.reason}`).slice(0, 8).join(',')}`);
        tokensByReason['profile'] = (tokensByReason['profile'] ?? 0) + d.tokens.profile;
        tokensByReason['notices'] = (tokensByReason['notices'] ?? 0) + d.tokens.notices;
        for (const a of d.added) {
          const key = a.reasons[0]?.kind === 'file' || a.reasons[0]?.kind === 'matched' ? `gated-${a.tier}` : (a.reasons[0]?.kind ?? 'none');
          tokensByReason[key] = (tokensByReason[key] ?? 0) + a.tokens;
          const reasons = a.reasons
            .map(r => (r.kind === 'matched' ? `matched(${r.terms.join(',')})` : r.kind === 'file' ? `file(${r.path})` : r.kind))
            .join(' ');
          const label = (a.title ?? a.content).replace(/\s+/g, ' ').slice(0, 90);
          log(`   [${a.tier}${a.upgradedFromCompact ? '↑' : ''}] ${a.scope}/${a.kind} score=${a.score?.toFixed(2) ?? '-'} ${reasons} :: ${label}`);
        }
        for (const n of d.notices) log(`   [notice:${n.kind}] ${n.id}`);
        promptIndex++;
      }
      log(`--- ${f}: baseline ${baseline}B -> new ${sessionNew}B (${baseline ? ((1 - sessionNew / baseline) * 100).toFixed(1) : '0'}% less)`);
      log(`SESSION ${f} baseline=${baseline} new=${sessionNew}`);
      baselineTotal += baseline;
      newTotal += sessionNew;
    }

    const reduction = baselineTotal ? 1 - newTotal / baselineTotal : 0;
    const p95 = percentile(timings, 95);
    log(`TOKENS BY REASON ${JSON.stringify(tokensByReason)}`);
    log(
      `REPLAY TOTAL baseline=${baselineTotal}B new=${newTotal}B reduction=${(reduction * 100).toFixed(1)}% ` +
        `prompts=${timings.length} p50=${percentile(timings, 50).toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );
    expect(reduction).toBeGreaterThanOrEqual(0.7);
    expect(p95).toBeLessThan(50);
  }, 600_000);
});
