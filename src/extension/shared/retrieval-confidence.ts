import { log } from '../logger';
import type { DatabaseInstance } from '../memory/types';

const MAX_HISTORY = 100;
const MIN_HISTORY_FOR_PERCENTILES = 10;

export interface ScoreHistoryEntry {
  peakScore: number;
  meanScore: number;
  spreadRatio: number;
  matchRatio: number;
  createdAt: number;
}

interface QueryMetrics {
  peakScore: number;
  meanScore: number;
  spreadRatio: number;
  matchRatio: number;
}

function computeMetrics(scores: number[], totalCandidates: number): QueryMetrics {
  const peakScore = scores.reduce((a, b) => a > b ? a : b, -Infinity);
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const spreadRatio = meanScore > 0 ? peakScore / meanScore : 1;
  const matchRatio = totalCandidates > 0 ? scores.length / totalCandidates : 0;
  return { peakScore, meanScore, spreadRatio, matchRatio };
}

export class RetrievalConfidenceTracker {
  private db: DatabaseInstance;
  private source: 'memory' | 'distill';
  private workspace: string;
  private cachedHistory: ScoreHistoryEntry[] | null = null;

  constructor(db: DatabaseInstance, source: 'memory' | 'distill', workspace: string) {
    this.db = db;
    this.source = source;
    this.workspace = workspace;
  }

  recordQueryScores(scores: number[], totalCandidates: number): void {
    if (scores.length === 0) return;

    const { peakScore, meanScore, spreadRatio, matchRatio } = computeMetrics(scores, totalCandidates);

    try {
      this.db.prepare(
        `INSERT INTO fts_score_history (source, workspace, peak_score, mean_score, spread_ratio, match_ratio, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(this.source, this.workspace, peakScore, meanScore, spreadRatio, matchRatio, Date.now());

      this.trimHistory();
    } catch (err) {
      log('[RetrievalConfidenceTracker] Failed to record scores: %O', err);
    }
    this.cachedHistory = null;
  }

  computeConfidence(scores: number[], totalCandidates: number): number {
    if (scores.length === 0) return 0.25;

    const { peakScore, spreadRatio, matchRatio } = computeMetrics(scores, totalCandidates);

    const history = this.getHistory();

    let peakPercentile: number;
    let spreadPercentile: number;

    if (history.length >= MIN_HISTORY_FOR_PERCENTILES) {
      peakPercentile = this.computePercentile(history, history.map(h => h.peakScore), peakScore);
      spreadPercentile = this.computePercentile(history, history.map(h => h.spreadRatio), spreadRatio);
    } else {
      peakPercentile = this.coldStartPercentile('peak', peakScore);
      spreadPercentile = this.coldStartPercentile('spread', spreadRatio);
    }

    const rawConfidence = peakPercentile * 0.5 + spreadPercentile * 0.3 + Math.min(matchRatio * 2, 1) * 0.2;
    return 0.25 + rawConfidence * 0.75;
  }

  private getHistory(): ScoreHistoryEntry[] {
    if (this.cachedHistory) return this.cachedHistory;

    try {
      const rows = this.db.prepare(
        `SELECT peak_score, mean_score, spread_ratio, match_ratio, created_at
         FROM fts_score_history
         WHERE source = ? AND workspace = ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).all(this.source, this.workspace, MAX_HISTORY) as Array<{
        peak_score: number;
        mean_score: number;
        spread_ratio: number;
        match_ratio: number;
        created_at: number;
      }>;

      this.cachedHistory = rows.map(r => ({
        peakScore: r.peak_score,
        meanScore: r.mean_score,
        spreadRatio: r.spread_ratio,
        matchRatio: r.match_ratio,
        createdAt: r.created_at,
      }));
    } catch (err) {
      log('[RetrievalConfidenceTracker] Failed to read history: %O', err);
      this.cachedHistory = [];
    }
    return this.cachedHistory;
  }

  private computePercentile(history: ScoreHistoryEntry[], values: number[], target: number): number {
    const now = Date.now();

    const weighted: Array<{ value: number; weight: number }> = values.map((v, i) => {
      const ageDays = (now - (history[i]?.createdAt ?? now)) / (24 * 60 * 60 * 1000);
      return { value: v, weight: Math.exp(-ageDays / 30) };
    });

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    if (totalWeight === 0) return 0.5;

    let belowWeight = 0;
    let equalWeight = 0;
    for (const w of weighted) {
      if (w.value < target) belowWeight += w.weight;
      else if (w.value === target) equalWeight += w.weight;
    }

    return (belowWeight + equalWeight * 0.5) / totalWeight;
  }

  private coldStartPercentile(metric: 'peak' | 'spread', value: number): number {
    if (metric === 'peak') {
      if (value >= 10) return 0.9;
      if (value >= 5) return 0.7;
      if (value >= 2) return 0.5;
      if (value >= 1) return 0.3;
      return 0.1;
    }
    if (value >= 5) return 0.9;
    if (value >= 3) return 0.7;
    if (value >= 2) return 0.5;
    if (value >= 1.5) return 0.3;
    return 0.1;
  }

  private trimHistory(): void {
    this.db.prepare(
      `DELETE FROM fts_score_history
       WHERE source = ? AND workspace = ?
       AND id NOT IN (
         SELECT id FROM fts_score_history
         WHERE source = ? AND workspace = ?
         ORDER BY created_at DESC
         LIMIT ?
       )`
    ).run(this.source, this.workspace, this.source, this.workspace, MAX_HISTORY);
  }
}
