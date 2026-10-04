/**
 * Keys core reads for one chat with that chat's folder (D38). Each declares "scope": "resource" in package.json, which a
 * test checks along with every folder-passing read in core. Every other key is window-level and read with no folder.
 */
export const CHAT_SETTING_KEYS: ReadonlySet<string> = new Set([
  "damocles.maxBudgetUsd",
  "damocles.taskBudget",
  "damocles.autoCompact",
  "damocles.thinkingDisabled",
  "damocles.effortByModel",
  "damocles.maxThinkingTokens",
  "damocles.permissionMode",
  "damocles.dangerouslySkipPermissions",
  "damocles.team.leadModel",
  "damocles.team.leadEffort",
  "damocles.team.implementorModel",
  "damocles.team.implementorEffort",
  "damocles.team.reviewerModel",
  "damocles.team.reviewerEffort",
  "damocles.subagents.maxConcurrent",
  "damocles.showCacheMissNotices",
  "damocles.showThinkingDroppedNotices",
]);
