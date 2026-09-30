/**
 * Public surface of the git checkpoint engine. Consumers (the checkpoint service, the pi session, and
 * the session store) import exclusively from this barrel; everything not re-exported here is internal
 * plumbing.
 */

export type {
  ExecEnv,
  Result,
  FileChange,
  CheckpointEntry,
  CheckpointEntryV2,
  CheckpointEntryV3,
  NotRewindableRecord,
  NotRewindableParams,
  CheckpointRecord,
  PreRewindRecord,
  PreRewindTarget,
  StoredCheckpointRecord,
  SafeCheckoutResult,
  RestoreResult,
  CheckpointExcludeSet,
  SkippedSummary,
  SkippedFile,
  SkippedPattern,
  SkippedTally,
  SkipReason,
  NotRewindableReason,
} from './types';
export {
  DEFAULT_CHECKPOINT_EXCLUDES,
  SECURITY_CHECKPOINT_EXCLUDES,
  PERFORMANCE_CHECKPOINT_EXCLUDES,
  LEGACY_CHECKPOINT_EXCLUDES,
  CHECKPOINT_EXCLUDE_SET,
  CHECKPOINT_EXCLUDE_SET_VERSION,
  CHECKPOINT_EXCLUDE_VERSION_KEY,
  CATEGORY_CHECKPOINT_EXCLUDES,
  FOLDER_CHECKPOINT_EXCLUDES,
  FOLDER_CHECKPOINT_EXCLUDE_SET,
  FOLDER_CHECKPOINT_EXCLUDE_SET_VERSION,
  isHexCommit,
  isSafeRefId,
} from './types';

export { exec, execSafe } from './exec';
export { setCheckpointGitAvailability, checkpointGitAvailability, type GitAvailability } from './git-availability';
export { withRepoLock, LockWaitAbortedError, type LockOptions } from './lock';
export { parseDiffStats } from './diff-parser';
export {
  getRepoDir,
  getGitDir,
  getIndexPath,
  getCheckpointsBaseDir,
  getWorkspaceCheckpointDir,
  getFolderReposBaseDir,
  getFolderRepoDir,
  folderIdFor,
  isFolderId,
} from './resolver';
export { getCheckpointEntries, getCheckpointRecords, getNotRewindableEntries, getPreRewindEntries } from './checkpoint-entry';
export { DEFAULT_MAX_FILE_SIZE_BYTES, excludeLineForPath, lstatFiles } from './exclusions';
export { RepoManager, BULK_ADD_CONFIG, PORTABLE_CONFIG } from './repo-manager';
export {
  checkpointRefName,
  sessionRefPrefix,
  folderRepoFor,
  folderRepoById,
  deleteSessionCheckpointRefs,
  folderIdsInSessionFile,
  copyCheckpointRefs,
  markForkCopyPending,
  readSkippedManifest,
  type FolderRepoHandle,
} from './folder-repo';
export { pruneOrphanCheckpointRepos } from './prune';
export {
  AutoCheckpointProducer,
  type AutoCheckpointProducerOptions,
  type AutoCheckpointTurnStartInput,
  type AutoCheckpointStartResult,
  type AutoCheckpointFinalizeResult,
  type AutoCheckpointSnapshotResult,
  type RestoreOptions,
} from './auto-checkpoint';
export {
  runCheckpointMaintenance,
  type CheckpointMaintenanceOptions,
  type CheckpointMaintenanceSummary,
} from './maintenance';
