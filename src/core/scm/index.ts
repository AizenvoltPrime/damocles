export { createGitRunner, gitAtLeast, parseGitVersion, redactUrls, revision, isSafeRevision, type GitBinary, type GitLog, type GitRunner, type GitVersion } from './git-runner';
export { ScmService, WATCH_DEBOUNCE_MS, PLAIN_VARIANT, type CommitHooks, type CommitInput, type CommitVariant, type UndoOutcome, type Decoration, type ProjectView, type RepoSnapshot, type ScmAsk, type ScmEvent, type ScmProject, type ScmQuestion, type ScmServiceDeps, type OpenFolderOutcome } from './scm-service';
export { STATUS_LIMIT, MAX_SHOW_BYTES, MAX_MESSAGE_CHARS, type Change, type ChangeGroup, type CommitFailure, type CommitOptions, type CommitOutcome, type HeadCommitSummary, type Repository, type RepositoryStatus } from './repository';
export { generateCommitMessage, COMMIT_MESSAGE_DIFF_CHARS, type CommitMessageComplete, type CommitMessageResult } from './commit-message';
export { SCM_SETTING_KEYS, type BranchProtectionPrompt, type PostCommitCommand, type PromptToSaveFilesBeforeCommit, type SmartCommitChanges, type UntrackedChanges } from './settings-keys';
export { commitHistory, recordCommitMessage, COMMIT_HISTORY_KEY, COMMIT_HISTORY_LIMIT } from './commit-history';
