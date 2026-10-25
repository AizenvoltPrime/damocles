// The protocol between desktop main and Damocles Core, shared by both sides; electron-free.
import { createEndpoint, type CoreProtocolError, type CoreTransport, type Endpoint } from './endpoint';
import { ERROR_CODEC } from './errors';
import { CORE_TO_MAIN, MAIN_TO_CORE, type CoreToMain, type MainToCore } from './messages';

export { CoreProtocolError, type CoreTransport, type PanelEnvelope } from './endpoint';
export { attachedTransport, CORE_MAX_MESSAGE_BYTES, type AttachedTransport } from './attached-transport';
export { createLoopback } from './loopback';
export {
  CLIENT_STATE_KEYS,
  DIFF_TITLE_NAME,
  parseCoreInit,
  parseScmProjects,
  type AskQuestion,
  type BrokerAnswer,
  type ClientAuth,
  type ClientPolicy,
  type ClientUser,
  type ChatEntry,
  type ChatPermissions,
  type CoreInit,
  type CoreMirrorTopics,
  type CredentialKind,
  type FolderTargetEntry,
  type MainRequests,
  type MentionTargetData,
  type MirrorTopics,
  type PanelCreate,
  type ScmMirrorPatch,
  type ScmRepositoryEntry,
  type SettingsViewScope,
  type StateScope,
} from './messages';
export { REPOSITORY_CALLS, SCM_CALLS, WORKTREE_CALLS, type FinishCall, type RepositoryCall, type ScmCall, type WorktreeCall, type WorktreeCalls } from './scm-calls';
export { PAGE_STATE_TYPES } from './messages';
export { INVALID } from './schema';

export type MainEndpoint = Endpoint<MainToCore, CoreToMain>;
export type CoreEndpoint = Endpoint<CoreToMain, MainToCore>;

// onViolation: what this side does with a message outside the contract; without it the violation is thrown (in process, tests)
export function createMainEndpoint(transport: CoreTransport, log: (line: string) => void, onViolation?: (error: CoreProtocolError) => void): MainEndpoint {
  return createEndpoint({ transport, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, log, errors: ERROR_CODEC, ...(onViolation ? { onViolation } : {}) });
}

export function createCoreEndpoint(transport: CoreTransport, log: (line: string) => void, onViolation?: (error: CoreProtocolError) => void): CoreEndpoint {
  return createEndpoint({ transport, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, log, errors: ERROR_CODEC, ...(onViolation ? { onViolation } : {}) });
}
