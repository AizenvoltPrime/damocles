import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { buildDiffWorker } from '../../diff/__tests__/worker-bundle';
import { createThreadDiffService, DIFF_WATCHDOG_GRACE_MS, type DiffService, type LineDiff, type LineDiffJob } from '../../diff';
import { REVIEW_DIFF_TIMEOUT_MS, reviewDiffJob, type FileText, type WorktreeGit } from '../chat-changes';
import { ChatReview, type ReviewSession } from '../chat-review';

/**
 * A worktree chat's review of the incident's file (docs/perf.md "Diff worker", "The incident") on the diff worker: core's
 * event loop stays responsive, the big file lists as too large within the review's budget while the file beside it keeps
 * its exact counts, unchanged texts are diffed once, and dispose answers a queued job at once.
 */

const BIG = 'big.json';
const REWRITE = 'rewrite.ts';
const bigBase = Array.from({ length: 57_616 }, (_, i) => `"k${i}": "v${i}",\n`).join('');
const bigNow = Array.from({ length: 89_011 }, (_, i) => (i % 4 === 0 ? `"k${i}": "v${i}",\n` : `"k${i}": "x${i}",\n`)).join('');
const rewriteBase = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join('');
const rewriteNow = Array.from({ length: 20_000 }, (_, i) => (i >= 9_850 && i < 10_150 ? `changed ${i}\n` : `line ${i}\n`)).join('');
// worker start, the file reads and hashes, and the 300-line rewrite's diff, on a loaded machine
const SLACK_MS = 2_000;
const MAX_LOOP_DELAY_MS = 250;

let workDir: string;
let bundle: string;
let root: string;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-review-worker-'));
  bundle = await buildDiffWorker(workDir);
  root = path.join(workDir, 'worktree');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, BIG), bigNow);
  fs.writeFileSync(path.join(root, REWRITE), rewriteNow);
}, 60_000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const fakeGit: WorktreeGit = {
  changedSinceBase: async () => [
    { status: 'M', path: BIG },
    { status: 'M', path: REWRITE },
  ],
  untracked: async () => [],
  atBase: async (_base, relative): Promise<FileText> => ({ kind: 'text', text: relative === BIG ? bigBase : rewriteBase }),
};

const session = (): ReviewSession => ({
  branch: [],
  sessionId: 's',
  sessionFile: path.join(root, 's.jsonl'),
  sessionDir: root,
  cwd: root,
  fileCheckpoints: false,
  worktree: { root, baseCommit: 'base', git: fakeGit, sharedWith: async () => 0 },
});

interface Answer {
  // the review file the job diffs, or the warm-up job
  readonly file: string;
  readonly answer: LineDiff;
  readonly at: number;
}

const fileOf = (job: LineDiffJob): string => (job.before === bigBase ? BIG : job.before === rewriteBase ? REWRITE : 'warm-up');

// The thread service, counting the jobs sent and recording each answer, in the order they came.
function counting(inner: DiffService): { readonly service: DiffService; readonly jobs: LineDiffJob[]; readonly answers: Answer[] } {
  const jobs: LineDiffJob[] = [];
  const answers: Answer[] = [];
  return {
    jobs,
    answers,
    service: {
      lineDiff: (job, options) => {
        jobs.push(job);
        return inner.lineDiff(job, options).then((answer) => {
          answers.push({ file: fileOf(job), answer, at: performance.now() });
          return answer;
        });
      },
      filePatch: (file, before, after) => inner.filePatch(file, before, after),
      editPatch: (file, baseContent, newContent, replacements) => inner.editPatch(file, baseContent, newContent, replacements),
      close: () => inner.close(),
    },
  };
}

function review(diff: DiffService): ChatReview {
  return new ChatReview({
    enabled: () => true,
    session,
    pendingBaseline: () => Promise.resolve(undefined),
    publish: () => undefined,
    watchFolder: () => ({ dispose: () => undefined }),
    watchTree: () => ({ dispose: () => undefined }),
    diff,
  });
}

describe('the chat review on the diff worker', () => {
  it('keeps the event loop responsive, lists the big file as too large within budget, and diffs unchanged texts once', async () => {
    const counted = counting(createThreadDiffService(bundle));
    const chat = review(counted.service);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    try {
      delay.enable();
      // the histogram keeps no delay before its timer's first run
      await new Promise((resolve) => setTimeout(resolve, 50));
      const start = performance.now();
      const snapshot = await chat.compute('chat', { fresh: true });
      const elapsed = performance.now() - start;
      // a delay is recorded when the histogram's timer next runs
      await new Promise((resolve) => setTimeout(resolve, 50));
      delay.disable();
      const maxDelayMs = delay.max / 1e6;
      const measured = `max event-loop delay ${Math.round(maxDelayMs)} ms, elapsed ${Math.round(elapsed)} ms`;
      expect(maxDelayMs, measured).toBeLessThan(MAX_LOOP_DELAY_MS);
      expect(elapsed, measured).toBeLessThanOrEqual(REVIEW_DIFF_TIMEOUT_MS + DIFF_WATCHDOG_GRACE_MS + SLACK_MS);
      const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
      expect(byPath.get(BIG)).toMatchObject({ added: 0, removed: 0, commentable: false });
      expect(byPath.get(REWRITE)).toMatchObject({ added: 300, removed: 300, commentable: true });
      expect(await chat.fileDiff('chat', BIG)).toEqual({ kind: 'tooLarge' });
      expect(counted.jobs).toHaveLength(2);

      await chat.compute('chat', { fresh: true });
      expect(counted.jobs).toHaveLength(2);
    } finally {
      await chat.dispose();
      await counted.service.close();
    }
  }, 180_000);

  it('dispose answers the review\'s queued job at once and the running one when it finishes, within its budget', async () => {
    const counted = counting(createThreadDiffService(bundle));
    const chat = review(counted.service);
    try {
      // with the worker ready, the review's first job runs the moment it is queued
      await counted.service.lineDiff(reviewDiffJob('a\n', 'b\n'));
      chat.schedule();
      await expect.poll(() => counted.jobs.length, { timeout: 10_000 }).toBe(3);
      const start = performance.now();
      await chat.dispose();
      const took = performance.now() - start;
      const answers = counted.answers.slice(1);
      expect(answers.map(({ file, answer }) => [file, answer])).toEqual([[REWRITE, { kind: 'tooLarge' }], [BIG, { kind: 'tooLarge' }]]);
      // the queued job was answered at dispose, the running one only once its budget ran out
      expect(answers[0]!.at - start).toBeLessThan(MAX_LOOP_DELAY_MS);
      expect(answers[1]!.at - start).toBeGreaterThanOrEqual(500);
      expect(took).toBeGreaterThanOrEqual(500);
      expect(took).toBeLessThanOrEqual(REVIEW_DIFF_TIMEOUT_MS + DIFF_WATCHDOG_GRACE_MS);
    } finally {
      await counted.service.close();
    }
  }, 60_000);
});
