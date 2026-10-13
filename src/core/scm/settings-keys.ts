// The damocles.desktop.git.* keys the engine reads; they must equal the keys desktop-configuration.ts declares
// (src/desktop/main/__tests__/scm-settings-keys.test.ts checks it), since core cannot import the desktop table.

export const SCM_SETTING_KEYS = {
  untrackedChanges: 'damocles.desktop.git.untrackedChanges',
  repositoryScanMaxDepth: 'damocles.desktop.git.repositoryScanMaxDepth',
  openRepositoryInParentFolders: 'damocles.desktop.git.openRepositoryInParentFolders',
  inputValidation: 'damocles.desktop.git.inputValidation',
  inputValidationSubjectLength: 'damocles.desktop.git.inputValidationSubjectLength',
  inputValidationLength: 'damocles.desktop.git.inputValidationLength',
  allowNoVerifyCommit: 'damocles.desktop.git.allowNoVerifyCommit',
  confirmNoVerifyCommit: 'damocles.desktop.git.confirmNoVerifyCommit',
  confirmEmptyCommits: 'damocles.desktop.git.confirmEmptyCommits',
  enableSmartCommit: 'damocles.desktop.git.enableSmartCommit',
  suggestSmartCommit: 'damocles.desktop.git.suggestSmartCommit',
  smartCommitChanges: 'damocles.desktop.git.smartCommitChanges',
  postCommitCommand: 'damocles.desktop.git.postCommitCommand',
  branchProtection: 'damocles.desktop.git.branchProtection',
  branchProtectionPrompt: 'damocles.desktop.git.branchProtectionPrompt',
  promptToSaveFilesBeforeCommit: 'damocles.desktop.git.promptToSaveFilesBeforeCommit',
  alwaysSignOff: 'damocles.desktop.git.alwaysSignOff',
  enableCommitSigning: 'damocles.desktop.git.enableCommitSigning',
  branchPrefix: 'damocles.desktop.git.branchPrefix',
} as const;

export type UntrackedChanges = 'mixed' | 'separate' | 'hidden';
export type OpenRepositoryInParentFolders = 'always' | 'never' | 'prompt';
export type SmartCommitChanges = 'all' | 'tracked';
export type PostCommitCommand = 'none' | 'push' | 'sync';
export type BranchProtectionPrompt = 'alwaysCommit' | 'alwaysCommitToNewBranch' | 'alwaysPrompt';
export type PromptToSaveFilesBeforeCommit = 'always' | 'staged' | 'never';
