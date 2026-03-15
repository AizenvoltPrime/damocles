import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryMessage, HistoryAgentMessage } from './content';
import type { McpServerStatusInfo } from './mcp';
import type { PluginStatusInfo } from './plugins';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, PluginAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate, QuestionAnnotations } from './permissions';
import type { PermissionMode, ContextStrategy, ProviderProfile, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig, ReasoningEffort, FastModeState } from './settings';
import type {
  SystemInitData,
  QueuedMessage,
  IdeContextDisplayInfo,
  MessageCheckpoint,
  ContextUsageData,
  RewindHistoryItem,
  RewindOption,
  AssistantMessage,
  PartialMessage,
  ResultMessage,
  StoredSession,
} from './session';
import type { MemoryTier, MemoryEntry, SearchQuery, SearchResult } from './memory';
import type { Task } from './subagents';
import type { MemoryInjectionDisplay } from './context-injection';
import type { RecallTrajectory, RecallIteration } from './recall';

import type { VoiceProvider, VoiceConfig } from './voice';
import type { RemoteControlStatus } from './remote-control';
import type { LoopJob } from './loop-jobs';

export type WebviewToExtensionMessage =
  | { type: "log"; message: string }
  | { type: "sendMessage"; content: string | UserContentBlock[]; agentId?: string; includeIdeContext?: boolean }
  | { type: "cancelSession" }
  | { type: "cancelAutoCompact" }
  | { type: "resumeSession"; sessionId: string }
  | {
      type: "approveEdit";
      toolUseId: string;
      approved: boolean;
      customMessage?: string;
      acceptAll?: boolean;
      parentToolUseId?: string;
      updatedPermissions?: PermissionUpdate[];
    }
  | { type: "ready"; savedSessionId?: string }
  | { type: "requestModels" }
  | { type: "setActiveModel"; model: string }
  | { type: "setDefaultModel"; model: string }
  | { type: "setMaxThinkingTokens"; tokens: number | null }
  | { type: "setThinkingDisabled"; disabled: boolean }
  | { type: "setEffort"; effort: ReasoningEffort | null }
  | { type: "setBudgetLimit"; budgetUsd: number | null }
  | { type: "toggleBeta"; beta: string; enabled: boolean }
  | { type: "setPermissionMode"; mode: PermissionMode }
  | { type: "setDefaultPermissionMode"; mode: PermissionMode }
  | { type: "setDangerouslySkipPermissions"; enabled: boolean }
  | { type: "rewindToMessage"; userMessageId: string; option: RewindOption; promptContent?: string }
  | { type: "requestRewindHistory" }
  | { type: "clearSession" }
  | { type: "interrupt" }
  | { type: "requestMcpStatus" }
  | { type: "requestSupportedCommands" }
  | { type: "openSettings" }
  | { type: "renameSession"; sessionId: string; newName: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "openSessionLog" }
  | { type: "openSessionPlan" }
  | { type: "bindPlanToSession" }
  | { type: "openAgentLog"; agentId: string }
  | { type: "requestMoreHistory"; sessionId: string; offset: number }
  | { type: "requestMoreSessions"; offset: number; selectedSessionId?: string }
  | { type: "searchSessions"; query: string; offset?: number; selectedSessionId?: string }
  | { type: "requestPromptHistory"; offset?: number }
  | { type: "requestWorkspaceFiles" }
  | { type: "openFile"; filePath: string; line?: number }
  | { type: "openExternalUrl"; url: string }
  | { type: "requestCustomSlashCommands" }
  | { type: "requestCustomAgents" }
  | { type: "queueMessage"; content: string | UserContentBlock[] }
  | { type: "cancelQueuedMessage"; messageId: string }
  | { type: "toggleMcpServer"; serverName: string; enabled: boolean }
  | { type: "reconnectMcpServer"; serverName: string }
  | { type: "authenticateMcpServer"; serverName: string }
  | { type: "togglePlugin"; pluginFullId: string; enabled: boolean }
  | { type: "requestPluginStatus" }
  | { type: "answerQuestion"; toolUseId: string; answers: Record<string, string> | null; annotations?: QuestionAnnotations }
  | {
      type: "approvePlan";
      toolUseId: string;
      approved: boolean;
      approvalMode?: "acceptEdits" | "manual";
      feedback?: string;
      clearContext?: boolean;
      planContent?: string;
    }
  | {
      type: "approveSkill";
      toolUseId: string;
      approved: boolean;
      approvalMode?: "acceptEdits" | "manual";
      customMessage?: string;
    }
  | { type: "setLanguagePreference"; locale: string }
  | { type: "createProviderProfile"; profile: ProviderProfile }
  | { type: "updateProviderProfile"; originalName: string; profile: ProviderProfile }
  | { type: "deleteProviderProfile"; profileName: string }
  | { type: "setActiveProviderProfile"; profileName: string | null }
  | { type: "setDefaultProviderProfile"; profileName: string | null }
  | { type: "requestProviderProfiles" }
  | { type: "requestMemories"; tier?: MemoryTier }
  | { type: "requestMoreObservations"; offset: number }
  | { type: "createMemory"; tier: MemoryTier; content: string; tags?: string[] }
  | { type: "updateMemory"; id: string; content: string; tags?: string[] }
  | { type: "deleteMemory"; id: string }
  | { type: "searchMemories"; query: SearchQuery }
  | { type: "setActiveContextStrategy"; strategy: ContextStrategy }
  | { type: "setDefaultContextStrategy"; strategy: ContextStrategy }
  | { type: "openContextFile"; promptIndex: number }
  | { type: "requestContextInjection"; promptIndex: number }
  | { type: "pinMemory"; id: string }
  | { type: "unpinMemory"; id: string }
  | { type: "startVoiceRecording" }
  | { type: "stopVoiceRecording" }
  | { type: "cancelVoiceRecording" }
  | { type: "setVoiceProvider"; provider: VoiceProvider }
  | { type: "setVoiceApiKey"; provider: VoiceProvider; apiKey: string }
  | { type: "deleteVoiceApiKey"; provider: VoiceProvider }
  | { type: "setVoiceLanguage"; language: string }
  | { type: "requestVoiceConfig" }
  | { type: "requestContextUsage" }
  | { type: "setFastMode"; enabled: boolean }
  | { type: "remoteControlEnable" }
  | { type: "remoteControlDisable" }
  | { type: "requestRemoteControlStatus" }
  | { type: "requestLoopJobs" }
  | { type: "cancelLoopJob"; taskId: string }
  | { type: "answerElicitation"; elicitationId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { type: "tagSession"; sessionId: string; tag: string | null }
  | { type: "sendBtw"; btwId: string; question: string }
  | { type: "cancelBtw"; btwId: string }
  | { type: "node-selected"; nodeId: string }
  | { type: "new-node-requested" }
  | { type: "node-picker-cancelled" }
  | { type: "close-node-request"; nodeId: string }
  | { type: "reopen-node-request"; nodeId: string }
  | { type: "dismiss-node-close-prompt" }
  | { type: "requestNodeTurns"; nodeId: string }
  | { type: "disconnect-node-relation"; nodeId: string; relatedNodeId: string };

export type ExtensionToWebviewMessage =
  | { type: "assistant"; data: AssistantMessage; parentToolUseId?: string | null }
  | { type: "partial"; data: PartialMessage; parentToolUseId?: string | null }
  | { type: "done"; data: ResultMessage }
  | { type: "userMessage"; content: string; contentBlocks?: UserContentBlock[]; correlationId: string }
  | { type: "userMessageIdAssigned"; sdkMessageId: string; correlationId: string }
  | { type: "toolPending"; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string | null }
  | { type: "error"; message: string }
  | { type: "sessionStarted"; sessionId: string }
  | { type: "processing"; isProcessing: boolean }
  | { type: "storedSessions"; sessions: StoredSession[]; hasMore?: boolean; nextOffset?: number; isFirstPage?: boolean }
  | { type: "sessionCleared"; pendingMessage?: { content: string; correlationId: string } }
  | { type: "conversationCleared" }
  | { type: "sessionRenamed"; sessionId: string; newName: string }
  | { type: "sessionDeleted"; sessionId: string }
  | { type: "notification"; message: string; notificationType: string }
  | { type: "accountInfo"; data: AccountInfo }
  | { type: "availableModels"; models: ModelInfo[] }
  | { type: "systemInit"; data: SystemInitData }
  | { type: "settingsUpdate"; settings: ExtensionSettings }
  | { type: "supportedCommands"; commands: SlashCommandInfo[] }
  | { type: "budgetWarning"; currentSpend: number; limit: number; percentUsed: number }
  | { type: "budgetExceeded"; finalSpend: number; limit: number }
  | { type: "mcpServerStatus"; servers: McpServerStatusInfo[] }
  | { type: "checkpointInfo"; checkpoints: MessageCheckpoint[] }
  | { type: "rewindComplete"; rewindToMessageId: string; option: RewindOption; promptContent?: string; fileRewindWarning?: string }
  | { type: "rewindError"; message: string }
  | { type: "toolStreaming"; messageId: string; tool: { id: string; name: string; input: Record<string, unknown> }; contentBlocks: ContentBlock[]; parentToolUseId?: string | null }
  | { type: "toolCompleted"; toolUseId: string; toolName: string; result: string; parentToolUseId?: string | null }
  | { type: "toolFailed"; toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; parentToolUseId?: string | null }
  | { type: "toolAbandoned"; toolUseId: string; toolName: string; parentToolUseId?: string | null }
  | { type: "toolMetadata"; toolUseId: string; metadata: Record<string, unknown> }
  | { type: "subagentStart"; agentId: string; agentType: string; toolUseId?: string }
  | { type: "subagentStop"; agentId: string; toolUseId?: string; lastAssistantMessage?: string }
  | { type: "stopInfo"; lastAssistantMessage?: string }
  | { type: "subagentModelUpdate"; agentToolId: string; model: string }
  | { type: "subagentMessagesUpdate"; agentToolId: string; messages: HistoryAgentMessage[] }
  | { type: "sessionCancelled" }
  | { type: "sessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { type: "sessionEnd"; reason: string }
  | { type: "preCompact"; trigger: "manual" | "auto" }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: "manual" | "auto"; summary?: string; timestamp?: number; isHistorical?: boolean }
  | { type: "compactSummary"; summary: string }
  | { type: "tasksUpdate"; tasks: Task[] }
  | { type: "contextUsage"; data: ContextUsageData | null; reason?: "busy" | "parseFailed" }
  | { type: "tokenUsageUpdate"; inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  | { type: "rewindHistory"; prompts: RewindHistoryItem[] }
  | { type: "userReplay"; content: string; contentBlocks?: ContentBlock[]; isSynthetic?: boolean; sdkMessageId?: string; isInjected?: boolean }
  | { type: "assistantReplay"; content: string; thinking?: string; tools?: HistoryToolCall[]; contentBlocks?: ContentBlock[] }
  | { type: "errorReplay"; content: string }
  | { type: "historyChunk"; messages: HistoryMessage[]; hasMore: boolean; nextOffset: number; promptIndexOffset: number }
  | { type: "promptHistory"; history: string[]; hasMore: boolean }
  | { type: "promptHistoryPush"; entry: string }
  | { type: "panelFocused" }
  | { type: "workspaceFiles"; files: WorkspaceFileInfo[] }
  | {
      type: "requestPermission";
      toolUseId: string;
      toolName: "Write" | "Edit" | "Bash";
      toolInput: Record<string, unknown>;
      filePath?: string;
      originalContent?: string;
      proposedContent?: string;
      command?: string;
      parentToolUseId?: string | null;
      editLineNumber?: number;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
    }
  | { type: "permissionAutoResolved"; toolUseId: string; parentToolUseId?: string | null }
  | { type: "customSlashCommands"; commands: SlashCommandItem[] }
  | { type: "customAgents"; agents: CustomAgentInfo[]; pluginAgents: PluginAgentInfo[] }
  | { type: "messageQueued"; message: QueuedMessage }
  | { type: "queueProcessed"; messageId: string }
  | { type: "queueBatchProcessed"; messageIds: string[]; combinedContent: string; contentBlocks?: UserContentBlock[] }
  | { type: "queueCancelled"; messageId: string }
  | { type: "flushedMessagesAssigned"; queueMessageIds: string[]; sdkMessageId: string }
  | { type: "mcpConfigUpdate"; servers: McpServerStatusInfo[] }
  | { type: "pluginConfigUpdate"; plugins: PluginStatusInfo[] }
  | { type: "pluginStatus"; plugins: PluginStatusInfo[] }
  | { type: "requestQuestion"; toolUseId: string; questions: Question[]; parentToolUseId?: string | null }
  | { type: "ideContextUpdate"; context: IdeContextDisplayInfo | null }
  | {
      type: "requestPlanApproval";
      toolUseId: string;
      planContent: string;
      parentToolUseId?: string | null;
    }
  | {
      type: "requestSkillApproval";
      toolUseId: string;
      skillName: string;
      skillDescription?: string;
      parentToolUseId?: string | null;
    }
  | {
      type: "interruptRecovery";
      correlationId: string;
      promptContent: string;
    }
  | { type: "languageChange"; locale: string }
  | { type: "showPlanContent"; content: string; filePath: string }
  | { type: "providerProfilesUpdate"; profiles: ProviderProfile[]; activeProfile: string | null; defaultProfile: string | null }
  | { type: "contextWarning"; level: ContextWarningLevel }
  | { type: "autoCompactTriggering"; percentUsed: number }
  | { type: "autoCompactComplete" }
  | { type: "autoCompactConfigUpdate"; config: AutoCompactConfig }
  | { type: "memoriesUpdate"; memories: MemoryEntry[]; hasMoreObservations?: boolean }
  | { type: "moreObservationsLoaded"; observations: MemoryEntry[]; hasMore: boolean }
  | { type: "memoryCreated"; memory: MemoryEntry }
  | { type: "memoryDeleted"; id: string }
  | { type: "searchResults"; results: SearchResult[] }
  | { type: "openMemoryPanel" }
  | { type: "memoryError"; message: string }
  | { type: "memoryPinned"; id: string }
  | { type: "memoryUnpinned"; id: string }
  | { type: "modelUpdate"; activeModel: string; defaultModel: string; contextWindowSize: number }
  | { type: "betaUpdate"; activeBetas: string[] }
  | { type: "contextStrategyUpdate"; activeStrategy: ContextStrategy; defaultStrategy: ContextStrategy }
  | { type: "contextInjectionLoaded"; promptIndex: number; data: RecallTrajectory | null; memoryData: MemoryInjectionDisplay | null }
  | { type: "contextInjectionStarted"; promptIndex: number }
  | { type: "recallIterationUpdate"; promptIndex: number; iteration: RecallIteration }
  | { type: "recallCompleted"; promptIndex: number; trajectory: RecallTrajectory }
  | { type: "memoryInjectionUpdate"; promptIndex: number; data: MemoryInjectionDisplay }
  | { type: "contextInjectionComplete"; promptIndex: number }
  | { type: "voiceRecordingStarted" }
  | { type: "transcriptionResult"; text: string }
  | { type: "transcriptionError"; message: string }
  | { type: "voiceConfigUpdate"; config: VoiceConfig; hasApiKey: boolean }
  | { type: "statusUpdate"; status: "compacting" | "ready"; permissionMode?: string }
  | { type: "taskStarted"; taskId: string; toolUseId?: string; description: string; taskType?: string }
  | { type: "taskNotification"; taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; summary: string; outputFile: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "toolProgress"; toolUseId: string; toolName: string; parentToolUseId: string | null; elapsedTimeSeconds: number; taskId?: string }
  | { type: "toolUseSummary"; summary: string; precedingToolUseIds: string[] }
  | { type: "authStatusUpdate"; isAuthenticating: boolean; error?: string }
  | { type: "filesPersisted"; files: { filename: string; fileId: string }[]; failed: { filename: string; error: string }[] }
  | { type: "hookLifecycle"; hookId: string; hookName: string; hookEvent: string; phase: "started" | "progress" | "response"; output?: string; exitCode?: number; outcome?: "success" | "error" | "cancelled" }
  | { type: "configChange"; source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'; filePath?: string }
  | { type: "fastModeStateUpdate"; state: FastModeState }
  | { type: "remoteControlStatusChanged"; status: RemoteControlStatus }
  | { type: "loopJobsLoaded"; jobs: LoopJob[] }
  | { type: "loopJobCreated"; job: LoopJob }
  | { type: "loopJobUpdated"; taskId: string; updates: Partial<LoopJob> }
  | { type: "loopJobRemoved"; taskId: string }
  | { type: "taskProgress"; taskId: string; toolUseId?: string; description: string; summary?: string; lastToolName?: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "requestElicitation"; elicitationId: string; serverName: string; message: string; mode: 'form' | 'url'; url?: string; requestedSchema?: Record<string, unknown> }
  | { type: "sessionTagged"; sessionId: string; tag: string | null }
  | { type: "btwStreaming"; btwId: string; text: string }
  | { type: "btwComplete"; btwId: string; text: string }
  | { type: "btwError"; btwId: string; message: string }
  | { type: "show-node-picker"; activeNodes: Array<{ nodeId: string; title: string; turnCount: number; entityTags: string[]; lastActivityAge: string }>; canCreateNew: boolean; currentActiveNodeId: string | null }
  | { type: "node-created-preview"; nodeId: string; title: string; keyEntities: string[] }
  | { type: "show-node-close-prompt"; nodeId: string; title: string }
  | { type: "node-state-updated"; nodes: import('./recall').TaskNodeDisplay[]; activeNodeId: string | null }
  | { type: "node-closed-confirmed"; nodeId: string }
  | { type: "node-close-failed"; nodeId: string }
  | { type: "nodeTurnsLoaded"; nodeId: string; turns: import('./recall').NodeTurnDisplay[]; seedContext: string | null; relatedNodes: import('./recall').RelatedNodeSummaryCard[] };
