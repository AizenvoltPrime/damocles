// Every line diff in core runs on a diff worker, never on a host thread (docs/perf.md "Diff worker").
export { createThreadDiffService, diffService, installDiffService, DIFF_WATCHDOG_GRACE_MS, type DiffService } from './service';
export type { LineDiff, LineDiffJob } from './protocol';
