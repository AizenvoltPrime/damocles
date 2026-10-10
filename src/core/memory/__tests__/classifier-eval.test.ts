import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryModelsStore, isRetryableAssistantError, type Api, type ClassifierApi, type ClassifierModel, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createDatabaseWrapper } from '../database';
import { CONTRADICTION_THRESHOLDS, contradictionRequest } from '../classifier-judges';
import { RetrievalManager } from '../managers/retrieval-manager';
import { buildFtsMatchQuery } from '../text-tokenize';
import { runStructuredCompletion } from '../../pi-session/structured-completion';
import { pickClassifierModel } from '../../pi-session/classifier-model';
import type { MemoryClassifyRequest, MemorySubCallRequest, MemorySubCallRunner } from '../subcall-runner';
import type { DatabaseInstance } from '../types';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

vi.mock('../query-expansion', () => ({
  expandQuery: vi.fn(async () => [] as string[]),
  expandMemoryTerms: vi.fn(async () => [] as string[]),
  clearExpansionCache: vi.fn(() => {}),
}));

/**
 * Calibrates the Jev memory judges against a COPY of the real memory store. Opt-in and paid:
 *   DAMOCLES_JEV_EVAL=1 with TYPESAFE_API_KEY or OPENROUTER_API_KEY in the environment.
 * Optional: DAMOCLES_JEV_EVAL_STORE (default `~/.damocles/memory.v3.db` of the OS user, since tests run
 * with a hermetic home), DAMOCLES_JEV_EVAL_N (cases per judge, default 40), DAMOCLES_JEV_EVAL_LLM
 * (`<provider>/<model>` with its key in the environment) to grade reranks against the LLM, and
 * DAMOCLES_JEV_EVAL_OUT to write the report, including sampled negative pairs for hand review, to a file.
 * Contradiction positives are `UPDATES`/`SUPERSEDES` edges; negatives are same-scope FTS neighbours
 * with no edge between them. The chosen thresholds and batching are pinned in `classifier-judges.test.ts`.
 */
const ENABLED = process.env['DAMOCLES_JEV_EVAL'] === '1';
const STORE = process.env['DAMOCLES_JEV_EVAL_STORE'] ?? path.join(os.userInfo().homedir, '.damocles', 'memory.v3.db');
const N = Number(process.env['DAMOCLES_JEV_EVAL_N'] ?? 40);
const LLM = process.env['DAMOCLES_JEV_EVAL_LLM'];
const REPORT = process.env['DAMOCLES_JEV_EVAL_OUT'];
const INJECTION_CAP_MS = 2000;

function copyStore(): { db: DatabaseInstance; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-jev-eval-'));
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(STORE + ext)) fs.copyFileSync(STORE + ext, path.join(dir, `memory.v3.db${ext}`));
  }
  return { db: createDatabaseWrapper(new DatabaseSync(path.join(dir, 'memory.v3.db'))), dir };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

interface Pair {
  newId: string;
  oldId: string;
  newFact: string;
  oldFact: string;
  label: boolean;
}

function contradictionPairs(db: DatabaseInstance): Pair[] {
  const positives = db.prepare(
    `SELECT e.source_id AS newId, e.target_id AS oldId, s.content AS newFact, t.content AS oldFact
       FROM memory_edges e JOIN memories s ON s.id = e.source_id JOIN memories t ON t.id = e.target_id
      WHERE e.kind IN ('UPDATES', 'SUPERSEDES') AND s.kind = t.kind
      ORDER BY e.created_at DESC LIMIT ?`,
  ).all(N) as Array<Omit<Pair, 'label'>>;
  const negatives: Pair[] = [];
  for (const p of positives) {
    const match = buildFtsMatchQuery(p.newFact, 12);
    if (!match) continue;
    const neighbour = db.prepare(
      `SELECT m.id, m.content FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? AND m.id NOT IN (?, ?) AND m.is_latest = 1 AND m.forgotten = 0
          AND m.scope = (SELECT scope FROM memories WHERE id = ?) AND m.kind = (SELECT kind FROM memories WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM memory_edges e WHERE (e.source_id = ? AND e.target_id = m.id) OR (e.source_id = m.id AND e.target_id = ?))
        ORDER BY f.rank LIMIT 1`,
    ).get(match, p.newId, p.oldId, p.newId, p.newId, p.newId, p.newId) as { id: string; content: string } | undefined;
    if (neighbour) negatives.push({ newId: p.newId, oldId: neighbour.id, newFact: p.newFact, oldFact: neighbour.content, label: false });
  }
  return [...positives.map((p) => ({ ...p, label: true })), ...negatives];
}

describe.skipIf(!ENABLED)('Jev memory judges against the real store', () => {
  const lines: string[] = [];
  const cleanup: Array<() => void> = [];
  afterAll(() => {
    if (REPORT) fs.writeFileSync(REPORT, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));
    for (const fn of cleanup) fn();
  });

  it('reports agreement, precision of true, latency against the cap, and cost per call', async () => {
    expect(fs.existsSync(STORE), `no memory store at ${STORE}`).toBe(true);
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-jev-auth-'));
    const runtime = await ModelRuntime.create({ authPath: path.join(authDir, 'auth.json'), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
    const ref = pickClassifierModel((ref) => runtime.hasConfiguredAuth(ref.provider));
    expect(ref, 'set TYPESAFE_API_KEY or OPENROUTER_API_KEY').not.toBeNull();
    const jev = runtime.getModelOfType('classifier', ref!.provider, ref!.id) as ClassifierModel<ClassifierApi>;
    const { db, dir } = copyStore();
    cleanup.push(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(authDir, { recursive: true, force: true });
    });
    lines.push(`model: ${jev.provider}/${jev.id}; thresholds ${JSON.stringify(CONTRADICTION_THRESHOLDS)}`);

    const latencies: number[] = [];
    const costs: number[] = [];
    const classify = async (req: MemoryClassifyRequest) => {
      const started = performance.now();
      const result = await runtime.classify(jev, { state: req.state, questions: req.questions }, { timeoutMs: req.timeoutMs });
      latencies.push(performance.now() - started);
      costs.push(result.usage?.cost.total ?? 0);
      return result.stopReason === 'stop' ? result.answers : null;
    };

    const pairs = contradictionPairs(db);
    const scored: Array<{ pair: Pair; p: number }> = [];
    for (const pair of pairs) {
      const answer = (await classify(contradictionRequest(pair.newFact, pair.oldFact)))?.['contradicts'];
      if (answer?.type === 'bool') scored.push({ pair, p: answer.probability });
    }
    lines.push(`contradiction pairs: ${pairs.filter((p) => p.label).length} positive, ${pairs.filter((p) => !p.label).length} negative, ${scored.length} answered`);
    for (const hi of [0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      const predicted = scored.filter((s) => s.p >= hi);
      const correct = predicted.filter((s) => s.pair.label).length;
      const lo = 1 - hi;
      const decided = scored.filter((s) => s.p >= hi || s.p <= lo);
      const agree = decided.filter((s) => (s.p >= hi) === s.pair.label).length;
      lines.push(
        `  T_hi ${hi.toFixed(2)} / T_lo ${lo.toFixed(2)}: precision(true) ${predicted.length ? (correct / predicted.length).toFixed(3) : 'n/a'} (${correct}/${predicted.length}), ` +
          `agreement ${decided.length ? (agree / decided.length).toFixed(3) : 'n/a'}, middle band ${scored.length - decided.length}/${scored.length}`,
      );
    }
    lines.push('negative samples for hand review (id pairs; texts only in DAMOCLES_JEV_EVAL_OUT):');
    for (const s of scored.filter((x) => !x.pair.label).slice(0, 10)) {
      lines.push(`  p=${s.p.toFixed(2)} ${s.pair.newId} vs ${s.pair.oldId}${REPORT ? `\n    NEW: ${s.pair.newFact}\n    OLD: ${s.pair.oldFact}` : ''}`);
    }
    const contradictionCalls = latencies.length;

    const llm: Model<Api> | undefined = LLM ? runtime.getModel(LLM.split('/')[0]!, LLM.split('/').slice(1).join('/')) : undefined;
    const runner = (withJev: boolean): MemorySubCallRunner => ({
      async run<T>(req: MemorySubCallRequest) {
        if (!llm) return { value: null, failure: 'no-model' as const };
        const result = await runStructuredCompletion<T>((m, c, o) => runtime.completeSimple(m, c, o), llm, {
          systemPrompt: req.systemPrompt,
          userMessage: req.prompt,
          outputToolName: 'submit_result',
          outputToolDescription: 'Return the structured result for this request.',
          schema: req.schema,
          purpose: 'memory-rerank',
          timeoutMs: 30_000,
        }, isRetryableAssistantError);
        return result.kind === 'answered' ? { value: result.value } : { value: null, failure: result.kind };
      },
      hasClassifier: () => withJev,
      classify,
    });
    const settings = createFakePlatform().settings;
    const queries = (db.prepare(`SELECT title FROM memories WHERE title IS NOT NULL AND is_latest = 1 AND forgotten = 0 ORDER BY updated_at DESC LIMIT ?`).all(N) as Array<{ title: string }>).map((r) => r.title);
    let compared = 0;
    let agreed = 0;
    for (const query of queries) {
      const jevResults = await new RetrievalManager(db, settings, runner(true)).search({ query, allWorkspaces: true });
      if (!llm) continue;
      const llmResults = await new RetrievalManager(db, settings, runner(false)).search({ query, allWorkspaces: true });
      const llmGrade = new Map(llmResults.map((r) => [r.id, r.rerankRelevance]));
      for (const r of jevResults) {
        const other = llmGrade.get(r.id);
        if (!r.rerankRelevance || !other) continue;
        compared++;
        if (other === r.rerankRelevance) agreed++;
      }
    }
    const rerankLatencies = latencies.slice(contradictionCalls);
    lines.push(`rerank: ${queries.length} queries, ${rerankLatencies.length} Jev requests; agreement with ${LLM ?? '(no DAMOCLES_JEV_EVAL_LLM)'}: ${compared ? `${(agreed / compared).toFixed(3)} (${agreed}/${compared})` : 'n/a'}`);
    lines.push(`latency ms: contradiction p50 ${percentile(latencies.slice(0, contradictionCalls), 50).toFixed(0)} p95 ${percentile(latencies.slice(0, contradictionCalls), 95).toFixed(0)}; rerank request p50 ${percentile(rerankLatencies, 50).toFixed(0)} p95 ${percentile(rerankLatencies, 95).toFixed(0)} (injection cap ${INJECTION_CAP_MS})`);
    lines.push(`cost per call: mean $${(costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length)).toFixed(8)} over ${costs.length} calls`);

    expect(scored.length).toBeGreaterThan(0);
    expect(percentile(rerankLatencies, 95)).toBeLessThan(INJECTION_CAP_MS);
  }, 30 * 60_000);
});
