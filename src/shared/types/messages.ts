import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryAgentMessage } from './content';
import type { McpServerStatusInfo } from './mcp';
import type { PluginStatusInfo } from './plugins';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, PluginAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate, QuestionAnnotations } from './permissions';
import type { PermissionMode, ContextStrategy, ProviderProfile, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig, EffortLevel, FastModeState, PanelThinkingState } from './settings';
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
import type { MemoryTier, MemoryEntry, SearchQuery, SearchResult, UserProfile } from './memory';
import type { PendingConsolidationCandidate, ConsolidationResult } from './consolidation';
import type { MemoryInjectionDisplay } from './context-injection';
import type { RecallTrajectory, RecallIteration, OrientationPhase, OrientationData, NodeRecallAttempt } from './recall';

import type { VoiceProvider, VoiceConfig, VoiceMode } from './voice';
import type { RemoteControlStatus } from './remote-control';
import type { LoopJob } from './loop-jobs';
import type { CompassIndexStatus, CompassGraphData, CompassSearchResult, CompassBlastRadiusResult, CompassNodeKind, CompassValidationResult } from './compass';

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
  | { type: "setBudgetLimit"; budgetUsd: number | null }
  | { type: "setTaskBudget"; budget: number | null }
  | { type: "toggleBeta"; beta: string; enabled: boolean }
  | { type: "setPermissionMode"; mode: PermissionMode }
  | { type: "setDefaultPermissionMode"; mode: PermissionMode }
  | { type: "setWorktreeBaseRef"; baseRef: 'fresh' | 'head' }
  | { type: "setDangerouslySkipPermissions"; enabled: boolean }
  | { type: "setPinnedHeaderHidden"; hidden: boolean }
  | { type: "rewindToMessage"; userMessageId: string; option: RewindOption; promptContent?: string }
  | { type: "requestRewindHistory" }
  | { type: "clearSession" }
  | { type: "interrupt" }
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
  | { type: "openRewindDiff"; filePath: string; userMessageId: string }
  | { type: "openExternalUrl"; url: string }
  | { type: "requestCustomSlashCommands" }
  | { type: "requestCustomAgents" }
  | { type: "queueMessage"; content: string | UserContentBlock[] }
  | { type: "cancelQueuedMessage"; messageId: string }
  | { type: "toggleMcpServer"; serverName: string; enabled: boolean }
  | { type: "reconnectMcpServer"; serverName: string }
  | { type: "reloadPlugins" }
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
  | { type: "set-active-node"; nodeId: string }
  | { type: "new-node-requested" }
  | { type: "regenerate-seed-context"; nodeId: string; customPrompt: string }
  | { type: "close-node-request"; nodeId: string; outcome: 'resolved' | 'partial' | 'abandoned' }
  | { type: "reopen-node-request"; nodeId: string }
  | { type: "dismiss-node-close-prompt" }
  | { type: "requestNodeTurns"; nodeId: string }
  | { type: "disconnect-node-relation"; nodeId: string; relatedNodeId: string }
  | { type: "stopBackgroundTask"; taskId: string }
  | { type: "stopWorkflow"; taskId: string; toolUseId: string }
  | { type: "getWorkflowTranscripts"; toolUseId: string; transcriptDir: string }
  | { type: "openWorkflowAgentLog"; logFile: string }
  | { type: "openWorkflowJournal"; transcriptDir: string }
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
  | { type: "requestExploreKeyStatus" }
  | { type: "requestExploreConfig" }
  | { type: "setOpenAIApiKey"; key: string; requestId: string }
  | { type: "clearOpenAIApiKey"; requestId: string }
  | { type: "getOpenAIAuthStatus" }
  | { type: "setOpenAIPreferApiKey"; preferApiKey: boolean; requestId: string }
  | { type: "startCodexOAuth" }
  | { type: "signOutCodex" }
  | { type: "getClaudeAuthStatus" }
  | { type: "claudeSignIn"; useAllowance: boolean }
  | { type: "claudeSetBilling"; useAllowance: boolean }
  | { type: "claudeSetApiKey"; key: string }
  | { type: "claudeSignOut" };

export type ExtensionToWebviewMessage =
  | { type: "assistant"; data: AssistantMessage; parentToolUseId?: string | null }
  | { type: "partial"; data: PartialMessage; parentToolUseId?: string | null }
  | { type: "done"; data: ResultMessage }
  | { type: "userMessage"; content: string; contentBlocks?: UserContentBlock[]; correlationId: string; promptIndex: number; nodeId: string | null; isInjected?: boolean }
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
  | { type: "mcpServerStatus"; servers: McpServerStatusInfo[] }
  | { type: "checkpointInfo"; userMessageIds: string[] }
  | { type: "togglePromptNavigator" }
  | { type: "rewindComplete"; rewindToMessageId: string; option: RewindOption; promptContent?: string; fileRewindWarning?: string }
  | { type: "rewindError"; message: string }
  | { type: "toolStreaming"; messageId: string; tool: { id: string; name: string; input: Record<string, unknown> }; contentBlocks: ContentBlock[]; parentToolUseId?: string | null }
  | { type: "toolCompleted"; toolUseId: string; toolName: string; result: string; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolFailed"; toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolAbandoned"; toolUseId: string; toolName: string; parentToolUseId?: string | null }
  | { type: "toolMetadata"; toolUseId: string; metadata: Record<string, unknown> }
  | { type: "subagentStart"; agentId: string; agentType: string; toolUseId?: string }
  | { type: "subagentStop"; agentId: string; toolUseId?: string; lastAssistantMessage?: string }
  | { type: "stopInfo"; lastAssistantMessage?: string }
  | { type: "subagentModelUpdate"; agentToolId: string; model: string }
  | { type: "openaiModelPricingUpdate"; pricing: Record<string, { input: number; cachedInput: number; output: number; reasoning: number }> }
  | { type: "subagentMessagesUpdate"; agentToolId: string; messages: HistoryAgentMessage[] }
  | { type: "sessionCancelled" }
  | { type: "sessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { type: "sessionEnd"; reason: string }
  | { type: "preCompact"; trigger: "manual" | "auto" }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: "manual" | "auto"; summary?: string; timestamp?: number; isHistorical?: boolean }
  | { type: "modelFallback"; id: string; fromModel: string; toModel: string; trigger: string; timestamp: number }
  | { type: "compactSummary"; summary: string }
  | { type: "contextUsage"; data: ContextUsageData | null; reason?: "busy" | "noQuery" }
  | { type: "contextUsageSummary"; totalTokens: number; maxTokens: number; percentage: number }
  | { type: "tokenUsageUpdate"; inputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }
  | { type: "rewindHistory"; prompts: RewindHistoryItem[]; canFork: boolean }
  | { type: "prefillInput"; text: string }
  | { type: "userReplay"; content: string; contentBlocks?: ContentBlock[]; isSynthetic?: boolean; sdkMessageId?: string; isInjected?: boolean; promptIndex: number; nodeId: string | null }
  | { type: "assistantReplay"; content: string; thinking?: string; tools?: HistoryToolCall[]; contentBlocks?: ContentBlock[] }
  | { type: "errorReplay"; content: string }
  | { type: "promptHistory"; history: string[]; hasMore: boolean }
  | { type: "promptHistoryPush"; entry: string }
  | { type: "panelFocused" }
  | { type: "workspaceFiles"; files: WorkspaceFileInfo[] }
  | {
      type: "requestPermission";
      toolUseId: string;
      toolName: "Write" | "Edit" | "Bash" | "PowerShell" | "Monitor";
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
  | { type: "pluginsReloaded"; errorCount: number }
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
  | { type: "memoryForgotten"; id: string; count: number }
  | { type: "memoryUnforgotten"; id: string; count: number }
  | { type: "memoryHistory"; id: string; entries: MemoryEntry[] }
  | { type: "relatedMemories"; id: string; entries: MemoryEntry[] }
  | { type: "profileData"; project: UserProfile; global: UserProfile }
  | { type: "consolidationPendingCount"; count: number }
  | { type: "consolidationPreview"; candidates: PendingConsolidationCandidate[] }
  | { type: "consolidationRunning"; running: boolean }
  | { type: "consolidationResult"; result: ConsolidationResult }
  | { type: "modelUpdate"; activeModel: string; defaultModel: string; contextWindowSize: number }
  | { type: "panelThinkingUpdate"; panel: PanelThinkingState; panelModel: string; defaults: PanelThinkingState; defaultsModel: string }
  | { type: "betaUpdate"; activeBetas: string[] }
  | { type: "contextStrategyUpdate"; activeStrategy: ContextStrategy; defaultStrategy: ContextStrategy }
  | { type: "contextInjectionLoaded"; promptIndex: number; data: RecallTrajectory | null; memoryData: MemoryInjectionDisplay | null }
  | { type: "contextInjectionStarted"; promptIndex: number }
  | { type: "orientationPhaseUpdate"; promptIndex: number; phase: OrientationPhase; orientation: OrientationData }
  | { type: "recallIterationUpdate"; promptIndex: number; iteration: RecallIteration }
  | { type: "recallCompleted"; promptIndex: number; trajectory: RecallTrajectory }
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
  | { type: "node-created-preview"; nodeId: string; title: string; keyEntities: string[] }
  | { type: "seed-context-regenerated"; nodeId: string }
  | { type: "show-node-close-prompt"; nodeId: string; title: string }
  | { type: "node-state-updated"; nodes: import('./recall').TaskNodeDisplay[]; activeNodeId: string | null; pendingNewNode: boolean }
  | { type: "node-closed-confirmed"; nodeId: string }
  | { type: "node-close-failed"; nodeId: string }
  | { type: "nodeTurnsLoaded"; nodeId: string; turns: import('./recall').NodeTurnDisplay[]; seedContext: string | null; seedContextPrompt: string | null; relatedNodes: import('./recall').RelatedNodeSummaryCard[]; recallAttempts: NodeRecallAttempt[] }
  | { type: "backgroundTaskStarted"; task: import('./background-tasks').BackgroundTask }
  | { type: "backgroundTaskProgress"; taskId: string; progressSummary: string; usage?: import('./background-tasks').BackgroundTask['usage']; lastToolName?: string }
  | { type: "backgroundTaskCompleted"; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string; outputFile: string | null; usage?: import('./background-tasks').BackgroundTask['usage'] }
  | { type: "backgroundTaskResult"; taskId: string; toolUseId: string; result: string; summary: string }
  | { type: "workflowResult"; toolUseId: string; taskId: string; status: import('./workflows').WorkflowStatus; summary: string; result: string; outputFile: string | null; transcriptDir?: string | null; usage?: import('./workflows').WorkflowUsage }
  | { type: "workflowTranscripts"; toolUseId: string; agents: import('./workflows').WorkflowAgentTranscript[]; seq?: number; error?: string }
  | { type: "monitorEvent"; taskId: string; summary: string; event: string }
  | { type: "browserElementPicked"; element: import('./browser').ElementAttachment }
  | { type: "browserStatusUpdate"; connected: boolean }
  | { type: "teamStarted"; team: import('./team').TeamState }
  | { type: "teamPhaseUpdate"; teamId: string; phase: import('./team').TeamPhase }
  | { type: "teamAgentStatusUpdate"; teamId: string; agentId: string; status: import('./team').TeamAgentStatus; progressSummary?: string; logFilePath?: string | null }
  | { type: "teamAgentToolCall"; teamId: string; agentId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "teamMessage"; teamId: string; message: import('./team').TeamMessage }
  | { type: "teamScratchpadUpdate"; teamId: string; entry: import('./team').ScratchpadEntry }
  | { type: "teamCompleted"; teamId: string; status: 'completed' | 'failed' | 'cancelled'; result: string | null }
  | { type: "teamAgentStreamDelta"; teamId: string; agentId: string; deltaType: 'thinking' | 'text'; text: string }
  | { type: "teamAgentAssistant"; teamId: string; agentId: string; messageId: string; content: import('./team').TeamAgentContentBlock[]; timestamp: number }
  | { type: "teamAgentUserMessage"; teamId: string; agentId: string; content: string; timestamp: number }
  | { type: "teamAgentToolResult"; teamId: string; agentId: string; toolUseId: string; result: string; isError?: boolean }
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
  | { type: "exploreConfigUpdate"; provider: string; model: string }
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
  | { type: "openaiCodexAuthStarted" }
  | { type: "openaiCodexAuthCompleted"; accountId: string | null }
  | { type: "openaiCodexAuthFailed"; error: string }
  | { type: "openaiCodexAuthExpired" }
  | { type: "openaiAuthRequired"; modelValue: string }
  | { type: "claudeAuthStatusChanged"; mode: "none" | "apikey" | "allowance" | "extra" }
  | { type: "claudeAuthBusy"; busy: boolean }
  | { type: "claudeAuthCancelled" }
  | { type: "claudeAuthError"; error: string };
