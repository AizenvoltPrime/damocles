import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryAgentMessage } from './content';
import type { McpConfigError, McpServerConfig, McpServerStatusInfo, McpWriteErrorInfo } from './mcp';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate, QuestionAnnotations } from './permissions';
import type { FormSchema, FormValues } from './forms';
import type { PermissionMode, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig, EffortLevel, PanelThinkingState, TeamRole } from './settings';
import type {
  SystemInitData,
  QueuedMessage,
  IdeContextDisplayInfo,
  ContextUsageData,
  RewindHistoryItem,
  RewindOption,
  AssistantMessage,
  PartialMessage,
  ResultMessage,
  StoredSession,
} from './session';
import type { SubscriptionUsageData } from './usage';
import type { RunningSubagentInfo } from './subagents';
import type { MemoryTier, MemoryEntry, SearchQuery, SearchResult, UserProfile, ObservationCursor } from './memory';
import type { PendingConsolidationCandidate, ConsolidationResult, ConsolidationPhaseEvent } from './consolidation';
import type { MemoryInjectionDisplay } from './context-injection';

import type { VoiceProvider, VoiceConfig, VoiceMode } from './voice';
import type { CompassIndexStatus, CompassGraphData, CompassSearchResult, CompassBlastRadiusResult, CompassNodeKind, CompassValidationResult } from './compass';
import type { ToolsSnapshot, ToolGroup } from './tools';

// Re-exported from ./memory (its true home) so existing transport-layer imports keep working.
export type { ObservationCursor } from './memory';

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
  | { type: "setPanelThinkingDisabled"; disabled: boolean }
  | { type: "setPanelEffort"; effort: EffortLevel | null; model: string }
  | { type: "setPanelMaxThinkingTokens"; tokens: number | null; model: string }
  | { type: "setDefaultThinkingDisabled"; disabled: boolean }
  | { type: "setDefaultEffort"; effort: EffortLevel | null; model: string }
  | { type: "setDefaultMaxThinkingTokens"; tokens: number | null }
  | { type: "setTeamRoleModel"; role: TeamRole; model: string }
  | { type: "setTeamRoleEffort"; role: TeamRole; effort: EffortLevel | null }
  | { type: "setBudgetLimit"; budgetUsd: number | null }
  | { type: "setTaskBudget"; budget: number | null }
  | { type: "setAutoCompact"; config: AutoCompactConfig }
  | { type: "setPermissionMode"; mode: PermissionMode }
  | { type: "setDefaultPermissionMode"; mode: PermissionMode }
  | { type: "setWorktreeBaseRef"; baseRef: 'fresh' | 'head' }
  | { type: "setDangerouslySkipPermissions"; enabled: boolean }
  | { type: "setDefaultDangerouslySkipPermissions"; enabled: boolean }
  | { type: "setIdeContextEnabled"; enabled: boolean }
  | { type: "setPinnedHeaderHidden"; hidden: boolean }
  | { type: "rewindToMessage"; userMessageId: string; option: RewindOption; promptContent?: string }
  | { type: "requestRewindHistory" }
  | { type: "clearSession" }
  | { type: "interrupt" }
  /** `requestId` identifies the exact card the webview optimistically marked, since one tool call id can
   *  appear in the streaming, subagent and team stores at once. Echoed back on `toolCancelRejected`. */
  | { type: "cancelToolCall"; toolUseId: string; note?: string; requestId?: string }
  | { type: "requestMcpStatus" }
  | { type: "requestSupportedCommands" }
  | { type: "openSettings" }
  | { type: "invokeSignIn" }
  | { type: "renameSession"; sessionId: string; newName: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "openSessionLog" }
  | { type: "openSessionPlan" }
  | { type: "bindPlanToSession" }
  | { type: "openAgentLog"; agentId: string }
  | { type: "requestMoreSessions"; offset: number; selectedSessionId?: string }
  | { type: "searchSessions"; query: string; offset?: number; selectedSessionId?: string }
  | { type: "requestPromptHistory"; offset?: number }
  | { type: "requestWorkspaceFiles" }
  | { type: "openFile"; filePath: string; line?: number }
  | { type: "openSystemPrompt" }
  | { type: "openMcpToolInfo"; piName: string }
  | { type: "openRewindDiff"; filePath: string; userMessageId: string }
  | { type: "openExternalUrl"; url: string }
  | { type: "requestCustomSlashCommands" }
  | { type: "requestCustomAgents" }
  | { type: "queueMessage"; content: string | UserContentBlock[] }
  | { type: "cancelQueuedMessage"; messageId: string }
  | { type: "toggleMcpServer"; serverName: string; enabled: boolean }
  | { type: "setMcpEnabled"; enabled: boolean }
  | { type: "reconnectMcpServer"; serverName: string }
  // Re-read every MCP source and re-feed the live client. `~/.claude.json` is deliberately unwatched,
  // so a server added there needs an explicit prompt to be picked up without a window reload.
  | { type: "mcpReloadConfig" }
  | { type: "authenticateMcpServer"; serverName: string }
  | { type: "reauthenticateMcpServer"; serverName: string }
  | { type: "signOutMcpServer"; serverName: string }
  // Management of the user-global `~/.damocles/mcp.json` only; `.claude`/`.codex` entries are
  // read-only imports and the workspace `.mcp.json` is the project's file. `serverName` on
  // `mcpUpdateServer` is the CURRENT (pre-rename) name; `newServerName` is present only on a rename.
  // `requestId` is echoed back in `mcpWriteResult` so the form knows which of its sends settled.
  | { type: "mcpAddServer"; requestId: string; serverName: string; config: McpServerConfig }
  | { type: "mcpUpdateServer"; requestId: string; serverName: string; newServerName?: string; config: McpServerConfig }
  | { type: "mcpDeleteServer"; requestId: string; serverName: string }
  | { type: "toggleTool"; toolName: string; enabled: boolean }
  | { type: "toggleToolGroup"; group: ToolGroup; enabled: boolean }
  | { type: "requestToolStatus" }
  | { type: "setProjectTrusted" }
  | { type: "answerQuestion"; toolUseId: string; answers: Record<string, string> | null; annotations?: QuestionAnnotations }
  | { type: "answerForm"; toolUseId: string; values: FormValues | null }
  | {
      type: "approvePlan";
      toolUseId: string;
      approved: boolean;
      approvalMode?: "acceptEdits" | "manual";
      feedback?: string;
      clearContext?: boolean;
    }
  | {
      type: "approveSkill";
      toolUseId: string;
      approved: boolean;
      approvalMode?: "acceptEdits" | "manual";
      customMessage?: string;
    }
  | { type: "setLanguagePreference"; locale: string }
  | { type: "requestMemories"; tier?: MemoryTier }
  | { type: "requestMoreObservations"; cursor?: ObservationCursor }
  | { type: "createMemory"; tier: Exclude<MemoryTier, 'observation'>; kind?: 'fact' | 'preference' | 'episode'; content: string; tags?: string[]; requestId?: string }
  | { type: "updateMemory"; id: string; content: string; tags?: string[] }
  | { type: "deleteMemory"; id: string }
  | { type: "searchMemories"; query: SearchQuery }
  | { type: "requestContextInjection"; promptIndex: number }
  | { type: "pinMemory"; id: string }
  | { type: "unpinMemory"; id: string }
  | { type: "forgetMemory"; id: string; scope?: "version" | "chain" }
  | { type: "unforgetMemory"; id: string; scope?: "version" | "chain" }
  | { type: "getMemoryHistory"; id: string }
  | { type: "getRelatedMemories"; id: string }
  | { type: "getProfile" }
  | { type: "setProfileSection"; scope: "project" | "global"; section: "static" | "dynamic"; content: string }
  | { type: "requestConsolidationPreview" }
  | { type: "triggerConsolidation" }
  | { type: "startVoiceRecording" }
  | { type: "stopVoiceRecording" }
  | { type: "cancelVoiceRecording" }
  | { type: "setVoiceProvider"; provider: VoiceProvider }
  | { type: "setVoiceApiKey"; provider: VoiceProvider; apiKey: string }
  | { type: "deleteVoiceApiKey"; provider: VoiceProvider }
  | { type: "setVoiceLanguage"; language: string }
  | { type: "setVoiceMode"; mode: VoiceMode }
  | { type: "setVoiceWakeWord"; wakeWord: string }
  | { type: "setVoiceWakeWordSensitivity"; sensitivity: number }
  | { type: "setVoiceTtsEnabled"; enabled: boolean }
  | { type: "setVoiceTtsVoice"; voice: VoiceConfig["ttsVoice"] }
  | { type: "setVoiceLocalGpu"; preference: VoiceConfig["localGpu"] }
  | { type: "setVoiceEndOfTurnSilenceMs"; ms: number }
  | { type: "setVoiceMaxUtteranceMs"; ms: number }
  | { type: "setVoiceAutoSubmit"; autoSubmit: boolean }
  | { type: "setVoiceDiagnostics"; diagnostics: boolean }
  | { type: "voiceStreamEnable" }
  | { type: "voiceStreamDisable" }
  | { type: "voiceStreamMute"; muted: boolean }
  | { type: "voiceWebviewMicUnavailable"; reason: "denied" | "stolen" | "no-device" }
  | { type: "voiceAcceptModelUpgrade"; modelIds: string[] }
  | { type: "voiceDismissModelUpgrade" }
  | { type: "voiceAcceptFirstRunModal" }
  | { type: "voiceCancelFirstRunModal" }
  | { type: "voiceCancelModelDownload" }
  | { type: "voiceRedownloadModels" }
  | { type: "voiceOpenModelsFolder" }
  | { type: "voiceFreeDiskSpace" }
  | { type: "voiceRemoveAllFiles" }
  | { type: "voiceQueryFilesSize" }
  | { type: "voiceTestVoice" }
  | { type: "requestVoiceConfig" }
  | { type: "requestContextUsage" }
  | { type: "requestSubscriptionUsage" }
  | { type: "answerElicitation"; elicitationId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { type: "tagSession"; sessionId: string; tag: string | null }
  | { type: "sendBtw"; btwId: string; question: string }
  | { type: "cancelBtw"; btwId: string }
  | { type: "stopBackgroundTask"; taskId: string }
  | { type: "steerSubagent"; agentId: string; message: string }
  | { type: "requestRunningSubagents" }
  | { type: "pickBrowserElement" }
  | { type: "openBrowser"; url: string }
  | { type: "openElementContext"; content: string }
  | { type: "requestTeamData"; teamId: string }
  | { type: "requestTeamDataByToolUse"; toolUseId: string }
  | { type: "cancelTeamAgent"; teamId: string; agentId: string }
  | { type: "requestTeamAgentData"; teamId: string; agentId: string }
  | { type: "teamAgentPermissionResponse"; requestId: string; behavior: 'allow' | 'deny' }
  | { type: "requestCompassReindex" }
  | { type: "compassSearch"; query: string; kind?: CompassNodeKind; limit?: number }
  | { type: "compassRequestGraph"; communityId?: number; maxNodes?: number }
  | { type: "compassNavigateToNode"; filePath: string; line: number }
  | { type: "compassRequestBlastRadius"; filePath: string; line: number }
  | { type: "compassDismissBlastRadius" }
  | { type: "compassRequestValidation" }
  | { type: "setExploreApiKey"; apiKey: string }
  | { type: "deleteExploreApiKey" }
  | { type: "setExploreProvider"; provider: string }
  | { type: "setExploreModel"; model: string }
  | { type: "setExploreEffort"; effort: string }
  | { type: "requestExploreKeyStatus" }
  | { type: "requestExploreConfig" }
  | { type: "setOpenAIApiKey"; key: string; requestId: string }
  | { type: "clearOpenAIApiKey"; requestId: string }
  | { type: "getOpenAIAuthStatus" }
  | { type: "setOpenAIPreferApiKey"; preferApiKey: boolean; requestId: string }
  | { type: "setStepfunApiKey"; key: string; requestId: string }
  | { type: "clearStepfunApiKey"; requestId: string }
  | { type: "getStepfunAuthStatus" }
  | { type: "setDeepseekApiKey"; key: string; requestId: string }
  | { type: "clearDeepseekApiKey"; requestId: string }
  | { type: "getDeepseekAuthStatus" }
  | { type: "startCodexOAuth" }
  | { type: "signOutCodex" }
  | { type: "getClaudeAuthStatus" }
  | { type: "claudeSignIn"; useAllowance: boolean }
  | { type: "claudeSetBilling"; useAllowance: boolean }
  | { type: "claudeSetApiKey"; key: string }
  | { type: "claudeSignOut" }
  | { type: "extensionUiResponse"; requestId: string; value: string | boolean | null };

/**
 * Carried by every message that reports MCP config state, so the two producers cannot disagree.
 *
 * True when `<ws>/.damocles/mcp.local.json` exists and git is not ignoring it, so the panel can warn
 * that a file holding credentials is committable. False when the file is absent, when git ignores it,
 * when the workspace is not a git repository, when the workspace is untrusted, and when the check
 * could not run.
 */
export interface McpLocalUnignoredFlag {
  localMcpUnignored: boolean;
}

export type ExtensionToWebviewMessage =
  | { type: "assistant"; data: AssistantMessage; parentToolUseId?: string | null }
  | { type: "partial"; data: PartialMessage; parentToolUseId?: string | null }
  | { type: "done"; data: ResultMessage }
  | { type: "userMessage"; content: string; contentBlocks?: UserContentBlock[]; correlationId: string; promptIndex: number; isInjected?: boolean }
  | { type: "userMessageIdAssigned"; sdkMessageId: string; correlationId: string }
  | { type: "toolPending"; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string | null }
  | { type: "error"; message: string }
  | { type: "authFailure"; message: string }
  | { type: "authFailureCleared" }
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
  | ({ type: "mcpServerStatus"; servers: McpServerStatusInfo[]; mcpEnabled: boolean; configErrors: McpConfigError[] } & McpLocalUnignoredFlag)
  | { type: "checkpointInfo"; userMessageIds: string[] }
  | { type: "togglePromptNavigator" }
  | { type: "rewindComplete"; rewindToMessageId: string; option: RewindOption; promptContent?: string; fileRewindWarning?: string }
  | { type: "rewindError"; message: string }
  | { type: "toolStreaming"; messageId: string; tool: { id: string; name: string; input: Record<string, unknown> }; contentBlocks: ContentBlock[]; parentToolUseId?: string | null }
  | { type: "toolCompleted"; toolUseId: string; toolName: string; result: string; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolFailed"; toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolAbandoned"; toolUseId: string; toolName: string; parentToolUseId?: string | null }
  /** No live shell call matched the cancel, so the optimistic "Stopping..." state has nothing to clear it.
   *  Match on `requestId` when present, else fall back to `toolUseId`. Not an error: the ordinary case is
   *  a click landing after the call finished. */
  | { type: "toolCancelRejected"; toolUseId: string; requestId?: string }
  | { type: "toolMetadata"; toolUseId: string; metadata: Record<string, unknown> }
  | { type: "subagentStart"; agentId: string; agentType: string; toolUseId?: string; isBackground?: boolean }
  | { type: "subagentStop"; agentId: string; toolUseId?: string; lastAssistantMessage?: string }
  | { type: "stopInfo"; lastAssistantMessage?: string }
  | { type: "subagentModelUpdate"; agentToolId: string; model: string }
  | { type: "subagentTemplateUpdate"; agentToolId: string; templatePath: string }
  | { type: "openaiModelPricingUpdate"; pricing: Record<string, { input: number; cachedInput: number; output: number; reasoning: number }> }
  | { type: "subagentMessagesUpdate"; agentToolId: string; messages: HistoryAgentMessage[] }
  | { type: "sessionCancelled" }
  | { type: "sessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { type: "sessionEnd"; reason: string }
  | { type: "preCompact"; trigger: "manual" | "auto" }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: "manual" | "auto"; summary?: string; timestamp?: number; isHistorical?: boolean; entryId?: string }
  | { type: "cacheMissNotice"; missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean; timestamp: number }
  | { type: "compactSummary"; summary: string }
  | { type: "contextUsage"; data: ContextUsageData | null; reason?: "busy" | "noQuery" }
  | { type: "subscriptionUsage"; data: SubscriptionUsageData }
  | { type: "contextUsageSummary"; totalTokens: number; maxTokens: number; percentage: number }
  | { type: "tokenUsageUpdate"; inputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }
  | { type: "rewindHistory"; prompts: RewindHistoryItem[]; canFork: boolean }
  | { type: "prefillInput"; text: string }
  | { type: "userReplay"; content: string; contentBlocks?: ContentBlock[]; isSynthetic?: boolean; sdkMessageId?: string; isInjected?: boolean; isMidStream?: boolean; steerTarget?: { agentId: string; agentType?: string; description?: string }; promptIndex: number }
  | { type: "assistantReplay"; content: string; thinking?: string; tools?: HistoryToolCall[]; contentBlocks?: ContentBlock[] }
  | { type: "errorReplay"; content: string }
  | { type: "promptHistory"; history: string[]; hasMore: boolean }
  | { type: "promptHistoryPush"; entry: string }
  | { type: "panelFocused" }
  | { type: "workspaceFiles"; files: WorkspaceFileInfo[] }
  | {
      type: "requestPermission";
      toolUseId: string;
      toolName: "Write" | "Edit" | "Bash" | "PowerShell";
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
  | { type: "runningSubagents"; agents: RunningSubagentInfo[] }
  | { type: "customAgents"; agents: CustomAgentInfo[] }
  | { type: "messageQueued"; message: QueuedMessage }
  | { type: "queueProcessed"; messageId: string }
  | { type: "queueBatchProcessed"; messageIds: string[]; combinedContent: string; contentBlocks?: UserContentBlock[] }
  | { type: "queueCancelled"; messageId: string }
  | { type: "flushedMessagesAssigned"; queueMessageIds: string[]; sdkMessageId: string }
  | ({ type: "mcpConfigUpdate"; servers: McpServerStatusInfo[]; configErrors: McpConfigError[] } & McpLocalUnignoredFlag)
  /**
   * The outcome of one `mcpAddServer`/`mcpUpdateServer`/`mcpDeleteServer`. Sent for every attempt,
   * success or failure, so the form can stay open holding the user's typed definition until the write
   * is known to have landed — a dialog that closes on send loses everything the user entered on any
   * rejection the webview could not predict.
   */
  | { type: "mcpWriteResult"; requestId: string; ok: true }
  | { type: "mcpWriteResult"; requestId: string; ok: false; error: McpWriteErrorInfo }
  | { type: "toolStatus"; data: ToolsSnapshot }
  | { type: "projectTrust"; trusted: boolean }
  | { type: "requestQuestion"; toolUseId: string; questions: Question[]; parentToolUseId?: string | null }
  | { type: "requestForm"; toolUseId: string; form: FormSchema; parentToolUseId?: string | null }
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
  | { type: "contextWarning"; level: ContextWarningLevel }
  | { type: "autoCompactTriggering"; percentUsed: number }
  | { type: "autoCompactComplete" }
  | { type: "autoCompactConfigUpdate"; config: AutoCompactConfig }
  | { type: "memoriesUpdate"; memories: MemoryEntry[]; hasMoreObservations?: boolean; observationCursor: ObservationCursor | null }
  | { type: "moreObservationsLoaded"; observations: MemoryEntry[]; hasMore: boolean; nextCursor: ObservationCursor | null }
  // requestId echoes a panel createMemory so only the matching in-flight create settles its token;
  // absent for chat /remember and consolidation, which must never settle a panel create.
  | { type: "memoryCreated"; memory: MemoryEntry; requestId?: string }
  // Targeted in-place replace for edits. replacedId set only when a version-chain
  // edit produced a new id (old id no longer is_latest); else same id replaced.
  | { type: "memoryUpdated"; memory: MemoryEntry; replacedId?: string }
  | { type: "memoryDeleted"; id: string }
  | { type: "searchResults"; results: SearchResult[]; query?: string }
  | { type: "openMemoryPanel" }
  // requestId echoes a panel createMemory so a failed create settles only its own token; a pin/delete
  // /forget failure carries source:'panel' but no requestId, so it never settles an in-flight create.
  | { type: "memoryError"; message: string; source?: "consolidation" | "panel"; requestId?: string }
  | { type: "memoryPinned"; id: string }
  | { type: "memoryUnpinned"; id: string }
  | { type: "memoryForgotten"; id: string; count: number }
  | { type: "memoryUnforgotten"; id: string; count: number }
  | { type: "memoryHistory"; id: string; entries: MemoryEntry[] }
  | { type: "relatedMemories"; id: string; entries: MemoryEntry[] }
  // savedSection is set when profileData follows a specific section save, so the panel confirms and
  // re-seeds ONLY that section (leaving unsaved drafts in the others untouched).
  | { type: "profileData"; project: UserProfile; global: UserProfile; savedSection?: { scope: "project" | "global"; section: "static" | "dynamic" } }
  // A failed section save: the panel clears that section's pending flag (keeping the draft) so a later
  // unrelated profileData can't silently overwrite the user's unsaved edit with the old server value.
  | { type: "profileSectionError"; scope: "project" | "global"; section: "static" | "dynamic"; message: string }
  | { type: "consolidationPendingCount"; count: number }
  | { type: "consolidationPreview"; candidates: PendingConsolidationCandidate[] }
  | { type: "consolidationRunning"; running: boolean }
  | { type: "consolidationProgress"; event: ConsolidationPhaseEvent }
  | { type: "consolidationResult"; result: ConsolidationResult }
  | { type: "modelUpdate"; activeModel: string; defaultModel: string; contextWindowSize: number }
  | { type: "panelThinkingUpdate"; panel: PanelThinkingState; panelModel: string; defaults: PanelThinkingState; defaultsModel: string }
  | { type: "contextInjectionLoaded"; promptIndex: number; memoryData: MemoryInjectionDisplay | null }
  | { type: "contextInjectionStarted"; promptIndex: number }
  | { type: "memoryInjectionUpdate"; promptIndex: number; data: MemoryInjectionDisplay }
  | { type: "contextInjectionComplete"; promptIndex: number }
  | { type: "voiceRecordingStarted" }
  | { type: "transcriptionResult"; text: string }
  | { type: "transcriptionError"; message: string }
  | { type: "voiceConfigUpdate"; config: VoiceConfig; hasApiKey: boolean }
  | { type: "voiceSidecarStatus"; state: "stopped" | "loading" | "ready" | "error" | "restarting"; device?: "cuda" | "cpu"; vramMbFree?: number; modelsLoaded?: string[]; message?: string }
  | { type: "voiceWakeDetected"; confidence: number }
  | { type: "voiceWakeAborted"; reason: "no-speech" | "user-cancel" }
  | { type: "voiceVadStarted" }
  | { type: "voiceVadEnded" }
  | { type: "voiceTranscriptFinal"; text: string; durationMs: number }
  | { type: "voiceTtsAudioChunk"; chunkBase64: string; sampleRate: number }
  | { type: "voiceTtsDone" }
  | { type: "voiceMicUnavailable"; reason: "denied" | "stolen" | "no-device" }
  | { type: "voiceModelDownloadProgress"; modelId: string; bytesReceived: number; bytesTotal: number; status: "downloading" | "verifying" | "done" | "error"; message?: string }
  | { type: "voiceModelDownloadAllDone" }
  | { type: "voiceModelDownloadCancelled" }
  | { type: "voiceModelUpgradeAvailable"; upgrades: { modelId: string; description: string; installedVersion: string; newVersion: string; bytesDelta: number; totalBytes: number; licenseUrl: string; license: string; gated: boolean }[] }
  | { type: "voiceFirstRunRequired"; reason: "missing-runtime" | "missing-models" | "first-time" }
  | { type: "voiceFilesSizeUpdate"; bytes: number }
  | { type: "voiceCpuFallbackActive"; reason: "no-cuda" | "low-vram" | "user-pref" | "cuda-oom-fallback" | "tts-unloaded" }
  | { type: "voiceTurnLost"; reason: "sidecar-crash" | "timeout" }
  | { type: "statusUpdate"; status: "compacting" | "ready"; permissionMode?: string }
  | { type: "taskStarted"; taskId: string; toolUseId?: string; description: string; taskType?: string; isBackground?: boolean }
  | { type: "taskNotification"; taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; summary: string; outputFile: string | null; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "toolProgress"; toolUseId: string; toolName: string; parentToolUseId: string | null; elapsedTimeSeconds: number; taskId?: string; output?: string; outputTruncated?: boolean }
  | { type: "toolUseSummary"; summary: string; precedingToolUseIds: string[] }
  | { type: "authStatusUpdate"; isAuthenticating: boolean; error?: string }
  | { type: "filesPersisted"; files: { filename: string; fileId: string }[]; failed: { filename: string; error: string }[] }
  | { type: "hookLifecycle"; hookId: string; hookName: string; hookEvent: string; phase: "started" | "progress" | "response"; output?: string; exitCode?: number; outcome?: "success" | "error" | "cancelled" }
  | { type: "configChange"; source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'; filePath?: string }
  | { type: "taskProgress"; taskId: string; toolUseId?: string; description: string; summary?: string; lastToolName?: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "requestElicitation"; elicitationId: string; serverName: string; message: string; mode: 'form' | 'url'; url?: string; requestedSchema?: Record<string, unknown> }
  | { type: "sessionTagged"; sessionId: string; tag: string | null }
  | { type: "btwStreaming"; btwId: string; text: string }
  | { type: "btwComplete"; btwId: string; text: string }
  | { type: "btwError"; btwId: string; message: string }
  | { type: "backgroundTaskStarted"; task: import('./background-tasks').BackgroundTask }
  | { type: "subagentSteered"; agentId: string; toolUseId: string | null; agentType?: string; description?: string; message: string; status: 'steered' | 'queued' | 'finished' | 'failed' | 'not-found' }
  | { type: "backgroundTaskProgress"; taskId: string; progressSummary: string; usage?: import('./background-tasks').BackgroundTask['usage']; lastToolName?: string }
  | { type: "backgroundTaskCompleted"; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string; outputFile: string | null; usage?: import('./background-tasks').BackgroundTask['usage'] }
  | { type: "backgroundTaskResult"; taskId: string; toolUseId: string; result: string; summary: string }
  | { type: "browserElementPicked"; element: import('./browser').ElementAttachment }
  | { type: "browserStatusUpdate"; connected: boolean }
  | { type: "teamStarted"; team: import('./team').TeamState }
  | { type: "teamPhaseUpdate"; teamId: string; phase: import('./team').TeamPhase }
  // A partial delta. An absent field means the sender has nothing new to say about it, not a reset.
  // `attempt` rides only on a launch, and an advance is what tells the card its work fields start over.
  | { type: "teamAgentStatusUpdate"; teamId: string; agentId: string; status: import('./team').TeamAgentStatus; progressSummary?: string; logFilePath?: string | null; model?: string; dollarBilled?: boolean; attempt?: number }
  | { type: "teamAgentToolCall"; teamId: string; agentId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "teamMessage"; teamId: string; message: import('./team').TeamMessage }
  | { type: "teamScratchpadUpdate"; teamId: string; entry: import('./team').ScratchpadEntry }
  | { type: "teamCompleted"; teamId: string; status: 'completed' | 'failed' | 'cancelled'; result: string | null }
  | { type: "teamAgentStreamDelta"; teamId: string; agentId: string; deltaType: 'thinking' | 'text'; text: string }
  | { type: "teamAgentAssistant"; teamId: string; agentId: string; messageId: string; content: import('./team').TeamAgentContentBlock[]; timestamp: number }
  | { type: "teamAgentUserMessage"; teamId: string; agentId: string; content: string; timestamp: number }
  | { type: "teamAgentToolProgress"; teamId: string; agentId: string; toolUseId: string; output: string; outputTruncated?: boolean }
  // `metadata` is the team path's only carrier for a tool result's `details`; the other two producers emit `toolMetadata`.
  | { type: "teamAgentToolResult"; teamId: string; agentId: string; toolUseId: string; result: string; isError?: boolean; metadata?: Record<string, unknown> }
  | { type: "teamAgentUsageUpdate"; teamId: string; agentId: string; totalInputTokens: number; totalOutputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
  | { type: "teamAgentTurnComplete"; teamId: string; agentId: string }
  | { type: "teamAgentDataLoaded"; teamId: string; agentId: string; messages: import('./team').TeamAgentContentBlock[][] }
  | { type: "teamAgentPermissionRequest"; requestId: string; teamId: string; agentId: string; agentName: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "sessionStateChanged"; state: 'idle' | 'running' | 'requires_action'; sessionId: string }
  | { type: "compassStatusUpdate"; status: CompassIndexStatus }
  | { type: "compassBuildProgress"; current: number; total: number; phase: 'build' | 'postprocess' | 'serialize'; label?: string }
  | { type: "compassSearchResults"; results: CompassSearchResult[] }
  | { type: "compassGraphData"; data: CompassGraphData }
  | { type: "compassBlastRadiusData"; data: CompassBlastRadiusResult }
  | { type: "compassBlastRadiusDismissed" }
  | { type: "compassValidationResult"; data: CompassValidationResult }
  | { type: "exploreApiKeyUpdate"; hasApiKey: boolean }
  | { type: "exploreConfigUpdate"; provider: string; model: string; effort: string }
  | { type: "exploreStarted"; toolUseId: string; model: string; prompt: string; description: string; startTime: number }
  | { type: "exploreDelta"; toolUseId: string; deltaType: 'text' | 'thinking'; text: string }
  | { type: "exploreToolCall"; toolUseId: string; innerToolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "exploreToolResult"; toolUseId: string; innerToolUseId: string; result: string; isError: boolean }
  | { type: "exploreCompleted"; toolUseId: string; status: 'completed' | 'failed'; result: string | null; elapsed: number; toolCount: number; model: string }
  | { type: "exploreMessagesUpdate"; toolUseId: string; messages: HistoryAgentMessage[] }
  | { type: "openaiAuthStatusChanged"; status: { codex: { signedIn: boolean; accountId?: string; expiresAt?: number }; apikey: { configured: boolean } }; preferApiKey: boolean }
  | { type: "setOpenAIApiKeyAck"; requestId: string; ok: boolean; validated?: boolean; modelCount?: number; warning?: string; error?: string }
  | { type: "clearOpenAIApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "setOpenAIPreferApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "setStepfunApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearStepfunApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "stepfunAuthStatusChanged"; configured: boolean }
  | { type: "setDeepseekApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearDeepseekApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "deepseekAuthStatusChanged"; configured: boolean }
  | { type: "openaiCodexAuthStarted" }
  | { type: "openaiCodexAuthCompleted"; accountId: string | null }
  | { type: "openaiCodexAuthFailed"; error: string }
  | { type: "openaiAuthRequired"; modelValue: string }
  | { type: "claudeAuthStatusChanged"; mode: "none" | "apikey" | "allowance" | "extra" }
  | { type: "claudeAuthBusy"; busy: boolean }
  | { type: "claudeAuthCancelled" }
  | { type: "claudeAuthError"; error: string }
  | { type: "openSettingsPanel" }
  | {
      type: "extensionUiRequest";
      requestId: string;
      kind: "select" | "confirm" | "input" | "editor";
      title: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      /**
       * Nested-agent attribution (subagent / team agent). The keys are OMITTED for the panel's own
       * dialogs, never set to `undefined` — the webview branches on presence. `agentName` is already
       * flattened and capped extension-side, at capture (`WebviewExtensionUIContext.forAgent`); the
       * webview renders it as text and must never re-sanitize or re-trust it.
       */
      agentId?: string;
      agentName?: string;
      teamId?: string;
    }
  /**
   * A dialog the extension has withdrawn (agent teardown, panel dispose, per-request abort). One
   * message per dropped requestId — the webview removes by id, and the request may not be the head of
   * its queue. There is no webview response leg: the awaiter has already been settled extension-side.
   */
  | { type: "extensionUiCancel"; requestId: string };
