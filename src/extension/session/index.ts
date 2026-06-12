export type {
  JsonlContentBlock,
  ClaudeSessionEntry,
  StoredSession,
  AgentToolCall,
  AgentData,
  ExtractedSessionStats,
  CompactInfo,
  ModelFallbackInfo,
  SessionReadResult,
  PersistUserMessageOptions,
  PersistPartialAssistantOptions,
  PersistInterruptOptions,
} from './types';

export {
  isValidSessionId,
  getClaudeProjectsDir,
  encodeProjectPath,
  getSessionDir,
  getSessionDirSync,
  ensureSessionDir,
  getSessionFilePath,
  getAgentFilePath,
  buildNodeFilePath,
  buildTeamFilePath,
  buildTeamAgentFilePath,
} from './paths';

export {
  findUserTextBlock,
  findUserImageBlocks,
} from './parsing';

export type { RawImageBlock } from './parsing';

export {
  listSessions,
  getSessionMetadata,
  sessionExists,
  readSessionEntries,
  readActiveBranchEntries,
  readAgentData,
  readSessionForDisplay,
  readLatestCompactSummary,
  readSessionOutputTokenTotal,
} from './reading';

export {
  initializeSession,
  persistUserMessage,
  persistPartialAssistant,
  persistInterruptMarker,
  persistCancelledPrompt,
  compactCancelledTurns,
  persistQueuedMessage,
  persistInjectedMessage,
  persistSubagentCorrelation,
  initSubagentFile,
  initNodeFile,
  persistSubagentEntry,
  appendSessionTitle,
  renameSession,
  deleteSession,
} from './writing';

export type { PersistInjectedMessageOptions } from './writing';

export {
  getActiveBranchUuids,
  getLastMessageUuid,
  getMessageParentUuid,
  findUserMessageInCurrentTurn,
  findLastMessageInCurrentTurn,
} from './branches';

export {
  extractPromptHistory,
} from './history';

export {
  tagSessionViaSDK,
  getSessionInfoFromSDK,
} from './sdk-operations';

export {
  loadIndex,
  saveIndex,
  updateEntry,
  removeEntry,
  touchEntry,
  clearMemoryCache as clearSessionIndexCache,
  type SessionIndexEntry,
} from './metadata-cache';
