export type {
  JsonlContentBlock,
  ClaudeSessionEntry,
  StoredSession,
  AgentToolCall,
  AgentData,
  ExtractedSessionStats,
  CompactInfo,
  PaginatedSessionResult,
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
  readSessionEntriesPaginated,
  readLatestCompactSummary,
} from './reading';

export {
  initializeSession,
  persistUserMessage,
  persistPartialAssistant,
  persistInterruptMarker,
  persistQueuedMessage,
  persistInjectedMessage,
  persistSubagentCorrelation,
  initSubagentFile,
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
