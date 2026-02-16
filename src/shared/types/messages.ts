import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryMessage, HistoryAgentMessage } from './content';
import type { McpServerStatusInfo } from './mcp';
import type { PluginStatusInfo } from './plugins';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, PluginAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate } from './permissions';
import type { PermissionMode, ContextStrategy, ProviderProfile, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig } from './settings';
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
import type { HaikuPromptActivity, AnnotationEntryDisplay, AnnotationLinkDisplay } from './haiku-observer';
import type { ContextInjectionDisplay } from './context-injection';
import type { VoiceProvider, VoiceConfig } from './voice';

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
  | { type: "openHaikuLog"; promptIndex: number }
  | { type: "openSessionPlan" }
  | { type: "bindPlanToSession" }
  | { type: "openAgentLog"; agentId: string }
  | { type: "requestMoreHistory"; sessionId: string; offset: number }
  | { type: "requestMoreSessions"; offset: number; selectedSessionId?: string }
  | { type: "searchSessions"; query: string; offset?: number; selectedSessionId?: string }
  | { type: "requestPromptHistory"; offset?: number }
  | { type: "requestWorkspaceFiles" }
  | { type: "openFile"; filePath: string; line?: number }
  | { type: "requestCustomSlashCommands" }
  | { type: "requestCustomAgents" }
  | { type: "queueMessage"; content: string | UserContentBlock[] }
  | { type: "cancelQueuedMessage"; messageId: string }
  | { type: "toggleMcpServer"; serverName: string; enabled: boolean }
  | { type: "togglePlugin"; pluginFullId: string; enabled: boolean }
  | { type: "requestPluginStatus" }
  | { type: "answerQuestion"; toolUseId: string; answers: Record<string, string> | null }
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
  | { type: "createMemory"; tier: MemoryTier; content: string; tags?: string[] }
  | { type: "updateMemory"; id: string; content: string; tags?: string[] }
  | { type: "deleteMemory"; id: string }
  | { type: "searchMemories"; query: SearchQuery }
  | { type: "setActiveContextStrategy"; strategy: ContextStrategy }
  | { type: "setDefaultContextStrategy"; strategy: ContextStrategy }
  | { type: "setDistillTokenBudget"; value: number }
  | { type: "openContextFile"; promptIndex: number }
  | { type: "requestHaikuActivity" }
  | { type: "requestContextInjection"; promptIndex: number }
  | { type: "startVoiceRecording" }
  | { type: "stopVoiceRecording" }
  | { type: "cancelVoiceRecording" }
  | { type: "setVoiceProvider"; provider: VoiceProvider }
  | { type: "setVoiceApiKey"; provider: VoiceProvider; apiKey: string }
  | { type: "deleteVoiceApiKey"; provider: VoiceProvider }
  | { type: "setVoiceLanguage"; language: string }
  | { type: "requestVoiceConfig" };

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
  | { type: "subagentStop"; agentId: string }
  | { type: "subagentModelUpdate"; taskToolId: string; model: string }
  | { type: "subagentMessagesUpdate"; taskToolId: string; messages: HistoryAgentMessage[] }
  | { type: "sessionCancelled" }
  | { type: "sessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { type: "sessionEnd"; reason: string }
  | { type: "preCompact"; trigger: "manual" | "auto" }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: "manual" | "auto"; summary?: string; timestamp?: number; isHistorical?: boolean }
  | { type: "compactSummary"; summary: string }
  | { type: "tasksUpdate"; tasks: Task[] }
  | { type: "contextUsage"; data: ContextUsageData }
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
  | { type: "memoriesUpdate"; memories: MemoryEntry[] }
  | { type: "memoryCreated"; memory: MemoryEntry }
  | { type: "memoryDeleted"; id: string }
  | { type: "searchResults"; results: SearchResult[] }
  | { type: "openMemoryPanel" }
  | { type: "memoryError"; message: string }
  | { type: "modelUpdate"; activeModel: string; defaultModel: string }
  | { type: "betaUpdate"; activeBetas: string[] }
  | { type: "contextStrategyUpdate"; activeStrategy: ContextStrategy; defaultStrategy: ContextStrategy; distillTokenBudget: number }
  | { type: "haikuObservationStart"; promptIndex: number }
  | { type: "haikuStreamDelta"; promptIndex: number; deltaType: 'thinking' | 'text'; delta: string }
  | { type: "haikuObservationComplete"; promptIndex: number; thinking: string; text: string; contextSnapshot?: string; annotationResult?: { annotationCount: number; lowRelevanceCount: number; linkCount: number; failedCount: number; summary: string; groups: string[]; entries?: AnnotationEntryDisplay[]; links?: AnnotationLinkDisplay[] } }
  | { type: "haikuActivityLoaded"; activities: HaikuPromptActivity[] }
  | { type: "contextInjectionLoaded"; promptIndex: number; data: ContextInjectionDisplay | null }
  | { type: "voiceRecordingStarted" }
  | { type: "transcriptionResult"; text: string }
  | { type: "transcriptionError"; message: string }
  | { type: "voiceConfigUpdate"; config: VoiceConfig; hasApiKey: boolean };
