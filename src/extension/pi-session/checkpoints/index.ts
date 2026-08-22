/**
 * Public surface of the per-session git checkpoint engine. Consumers (the checkpoint service, the
 * pi session, and the session store) import exclusively from this barrel; everything not re-exported
 * here is internal plumbing.
 */

export type {
  ExecEnv,
  Result,
  FileChange,
  CheckpointEntry,
  SafeCheckoutResult,
  CheckpointExcludeSet,
} from './types';
export {
  DEFAULT_CHECKPOINT_EXCLUDES,
  LEGACY_CHECKPOINT_EXCLUDES,
  CHECKPOINT_EXCLUDE_SET,
  CHECKPOINT_EXCLUDE_SET_VERSION,
  CHECKPOINT_EXCLUDE_VERSION_KEY,
  isHexCommit,
} from './types';

export { exec, execSafe } from './exec';
export { withRepoLock } from './lock';
export { parseDiffStats } from './diff-parser';
export { getRepoDir, getGitDir, getIndexPath, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from './resolver';
export { getCheckpointEntries } from './checkpoint-entry';
export { RepoManager } from './repo-manager';
export { pruneOrphanCheckpointRepos } from './prune';
export {
  AutoCheckpointProducer,
  type AutoCheckpointProducerOptions,
  type AutoCheckpointTurnStartInput,
  type AutoCheckpointTurnEndInput,
  type AutoCheckpointStartResult,
  type AutoCheckpointEndResult,
  type AutoCheckpointFinalizeResult,
} from './auto-checkpoint';
export {
  runCheckpointMaintenance,
  type CheckpointMaintenanceOptions,
  type CheckpointMaintenanceSummary,
} from './maintenance';
