// The protocol between desktop main and Damocles Core, shared by both sides; electron-free.
import type { ActorContext } from './actor';
import { createEndpoint, type CoreProtocolError, type CoreTransport, type Endpoint } from './endpoint';
import { ERROR_CODEC, errorCodec } from './errors';
import type { LocalizedText } from '../../shared/localized-text';
import { CORE_TO_MAIN, MAIN_TO_CORE, type CoreToMain, type MainToCore } from './messages';

export { CoreProtocolError, type CoreTransport, type PanelEnvelope } from './endpoint';
export { currentActor, processActor, type ActorContext } from './actor';
export { attachedTransport, CORE_MAX_MESSAGE_BYTES, type AttachedTransport } from './attached-transport';
export { createLoopback } from './loopback';
export {
  DIFF_TITLE_NAME,
  MAX_MESSAGE_CHARS,
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
  type CoreRequests,
  type CredentialKind,
  type EditorMirror,
  type FolderTargetEntry,
  type MainRequests,
  type MentionTargetData,
  type MirrorTopics,
  type PanelCreate,
  type ScmCommitOutcome,
  type ScmMirrorPatch,
  type ScmRepositoryEntry,
  type SettingsViewScope,
  type StateScope,
} from './messages';
export { REPOSITORY_CALLS, SCM_CALLS, WORKTREE_CALLS, type FinishCall, type RepositoryCall, type ScmCall, type WorktreeCall, type WorktreeCalls } from './scm-calls';
export { PAGE_STATE_TYPES } from './messages';
export { parsedCallText, SCM_CALL_LOCALIZED_TEXT, WORKTREE_CALL_LOCALIZED_TEXT } from './call-results';
export { INVALID } from './schema';

export type MainEndpoint = Endpoint<MainToCore, CoreToMain>;
export type CoreEndpoint = Endpoint<CoreToMain, MainToCore>;

// onViolation: what this side does with a message outside the contract; without it the violation is thrown (in process, tests).
// actor: only a daemon and its core pass one (endpoint.ts EndpointOptions.actor). render: desktop main's, which puts core's
// error text in main's language (errors.ts errorCodec).
export function createMainEndpoint(transport: CoreTransport, log: (line: string) => void, onViolation?: (error: CoreProtocolError) => void, actor?: ActorContext, render?: (text: LocalizedText) => string): MainEndpoint {
  return createEndpoint({ transport, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, log, errors: render ? errorCodec(render) : ERROR_CODEC, ...(onViolation ? { onViolation } : {}), ...(actor ? { actor } : {}) });
}

export function createCoreEndpoint(transport: CoreTransport, log: (line: string) => void, onViolation?: (error: CoreProtocolError) => void, actor?: ActorContext): CoreEndpoint {
  return createEndpoint({ transport, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, log, errors: ERROR_CODEC, ...(onViolation ? { onViolation } : {}), ...(actor ? { actor } : {}) });
}
