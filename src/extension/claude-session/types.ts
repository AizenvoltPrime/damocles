import type * as vscode from 'vscode';
import type { PermissionHandler } from '../permission-handler';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { McpServerConfig } from '../../shared/types/mcp';
import type { PluginConfig } from '../../shared/types/plugins';
import type { ContentBlock, UserContentBlock } from '../../shared/types/content';
import type { EffortLevel } from '../../shared/types/settings';
import type { ToolManager } from './tool-manager';
import type { StreamingManager } from './streaming-manager';
import type { MemoryService } from '../memory';
import type { BrowserService } from '../browser';
import type { RecallService } from '../recall';
import type { TeamService } from '../team';
import type { CompassService } from '../compass';
import type { PermissionUpdate } from '../../shared/types/permissions';
import type { LoopJobTracker } from './loop-job-tracker';
import type { ReadStateTracker } from './read-state-tracker';
import type { ForkContext, ForkSpawnArgs } from '../../shared/types/session';
import type { ExploreService } from '../explore';

/** Type for the Query object returned by the SDK */
export type Query = ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').query>;

/** Options for creating a ClaudeSession */
export interface SessionOptions {
  cwd: string;
  permissionHandler: PermissionHandler;
  onMessage: (message: ExtensionToWebviewMessage) => void;
  onSessionIdChange?: (sessionId: string | null) => void;
  onSessionPersisted?: (sessionId: string) => void;
  onAssistantTextFinal?: (text: string) => void;
  mcpServers?: Record<string, McpServerConfig>;
  plugins?: PluginConfig[];
  providerEnv?: Record<string, string>;
  model?: string;
  betas?: string[];
  memoryService?: MemoryService;
  browserService?: BrowserService;
  recallService?: RecallService;
  panelId?: string;
  chromeEnabled?: boolean;
  teamService?: TeamService;
  compassService?: CompassService;
  onSpawnFork?: (args: ForkSpawnArgs) => Promise<void>;
  forkContext?: ForkContext;
  resolveThinking: (model: string) => {
    thinkingDisabled: boolean;
    effort: EffortLevel | null;
    maxThinkingTokens: number | null;
  };
  secrets?: vscode.SecretStorage;
}

/** Callbacks for inter-manager communication */
export interface MessageCallbacks {
  onMessage: (message: ExtensionToWebviewMessage) => void;
  onSessionIdChange?: (sessionId: string | null) => void;
  onFlushedMessageComplete?: (content: string, queueMessageIds: string[]) => Promise<void>;
  onSessionConflict?: () => void;
  onAssistantTextFinal?: (text: string) => void;
}

/** Accumulated assistant message before flush */
export interface PendingAssistantMessage {
  id: string;
  model: string;
  stopReason: string | null;
  content: import('../../shared/types/content').ContentBlock[];
  sessionId: string;
  parentToolUseId: string | null;
}

/** Current streaming content accumulator */
export interface StreamingContent {
  messageId: string | null;
  model: string | null;
  thinking: string;
  text: string;
  isThinking: boolean;
  hasStreamedTools: boolean;
  thinkingStartTime: number | null;
  thinkingDuration: number | null;
  parentToolUseId: string | null;
  contentBlocks: ContentBlock[];
  committedTextLength: number;
  activeBlockIndex: number | null;
  activeBlockType: 'text' | 'thinking' | 'tool_use' | null;
  activeToolId: string | null;
  thinkingSignature: string;
}

/** Info about a streamed tool for correlation */
export interface StreamedToolInfo {
  toolName: string;
  messageId: string;
  parentToolUseId: string | null;
  approved?: boolean;
}

/** Content block for multi-part user messages */
export type TextContentBlock = { type: 'text'; text: string };

/** Content input type for SDK - text string or array of content blocks (text + images) */
export type ContentInput = string | UserContentBlock[];

/** Controller for streaming input mode - allows sending messages to an active query */
export interface StreamingInputController {
  sendMessage: (content: ContentInput) => void;
  close: () => void;
}

/** Tool permission result from canUseTool callback */
export type ToolPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** Rewind option for file/conversation restoration */
export type RewindOption = 'fork-conversation' | 'code-only' | 'fork-and-rewind-code';

/** Creates fresh streaming content state */
export function createEmptyStreamingContent(): StreamingContent {
  return {
    messageId: null,
    model: null,
    thinking: '',
    text: '',
    isThinking: false,
    hasStreamedTools: false,
    thinkingStartTime: null,
    thinkingDuration: null,
    parentToolUseId: null,
    contentBlocks: [],
    committedTextLength: 0,
    activeBlockIndex: null,
    activeBlockType: null,
    activeToolId: null,
    thinkingSignature: '',
  };
}

/** Queued message awaiting injection at tool boundary */
export interface QueuedMessage {
  id: string | null;
  content: ContentInput;
}

/** Dependencies for hook handler creation */
export interface HookDependencies {
  toolManager: ToolManager;
  streamingManager: StreamingManager;
  callbacks: MessageCallbacks;
  options: SessionOptions;
  getQueuedMessages: () => QueuedMessage[];
  spliceQueuedMessages: () => QueuedMessage[];
  getMemoryContext: (prompt?: string) => Promise<string>;
  getRecallContext: (userPrompt?: string) => Promise<string | null>;
  isFirstMessageOfSession: () => boolean;
  markFirstMessageSent: () => void;
  rerouteRemoteMessage: (prompt: string, correlationId?: string) => void;
  loopJobTracker: LoopJobTracker;
  readStateTracker: ReadStateTracker;
  getCompassContext: () => string;
  isCompassEnabled: () => boolean;
  exploreService: ExploreService | null;
  getAbortSignal: () => AbortSignal | null;
}
