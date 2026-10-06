import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryAgentMessage, ImageBlock } from './content';
import type {
  McpConfigError,
  McpRenamedToolRuleNotice,
  McpServerConfig,
  McpServerStatusInfo,
  McpToolExposureScope,
  McpToolExposureSetting,
  McpWriteErrorInfo,
} from './mcp';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate, QuestionAnnotations, PromptOwner, PendingPromptOwner, PromptApprover } from './permissions';
import type { FormSchema, FormValues } from './forms';
import type { PermissionMode, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig, CacheWarmingMode, EffortLevel, PanelThinkingState, TeamRole, MemoryJudge, ImageGenerationSettings } from './settings';
import type {
  SystemInitData,
  QueuedMessage,
  IdeContextDisplayInfo,
  ContextUsageData,
  RewindHistoryItem,
  RewindOption,
  RestorePoint,
  SkippedFile,
  SkippedFilesTarget,
  AssistantMessage,
  PartialMessage,
  ResultMessage,
  StoredSession,
  CompactionTrigger,
  ToolResultOwner,
} from './session';
import type { SubscriptionUsageData } from './usage';
import type { UsageStatsQuery, UsageStatsReport } from './usage-stats';
import type { SteerTargetInfo } from './subagents';
import type { AgentUsageTotals } from '../usage-accounting';
import type { MemoryTier, MemoryEntry, SearchQuery, SearchResult, UserProfile, ObservationCursor } from './memory';
import type { PendingConsolidationCandidate, ConsolidationResult, ConsolidationPhaseEvent } from './consolidation';
import type { MemoryInjectionDisplay } from './context-injection';
import type {
  MemoryAuditCancelResult,
  MemoryAuditErrorCode,
  MemoryAuditProgress,
  MemoryAuditResult,
  MemoryAuditStatePayload,
  MemoryAuditSummary,
} from './memory-audit';

import type { VoiceProvider, VoiceConfig, VoiceMode } from './voice';
import type { CompassIndexStatus, CompassGraphData, CompassSearchResult, CompassBlastRadiusResult, CompassNodeKind, CompassValidationResult } from './compass';
import type { ToolsSnapshot, ToolGroup } from './tools';
import type { WorkspaceFolderInfo } from './workspace-folders';
import type { SettingsAccountId, SettingsSectionId } from '../settings-sections';

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
      updatedPermissions?: PermissionUpdate[];
    }
  | { type: "ready"; panelToken: string; savedSessionId?: string; savedWorkspaceFolderKey?: string }
  | { type: "setActiveModel"; model: string }
  | { type: "setDefaultModel"; model: string }
  | { type: "setPanelWorkspaceFolder"; folderKey: string }
  | { type: "setDefaultWorkspaceFolder"; folderKey: string }
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
  | { type: "setCacheWarming"; mode: CacheWarmingMode }
  /** Whole days, 0 keeps checkpoints forever. */
  | { type: "setCheckpointRetentionDays"; days: number }
  | { type: "setPermissionMode"; mode: PermissionMode }
  | { type: "setDefaultPermissionMode"; mode: PermissionMode }
  | { type: "setDangerouslySkipPermissions"; enabled: boolean }
  | { type: "setDefaultDangerouslySkipPermissions"; enabled: boolean }
  | { type: "setIdeContextEnabled"; enabled: boolean }
  | { type: "setPinnedHeaderHidden"; hidden: boolean }
  | { type: "rewindToMessage"; userMessageId: string; option: RewindOption; promptContent?: string }
  | { type: "requestRewindHistory" }
  /** Put back the files a rewind replaced, from the restore point `preRewindId`; files only. */
  | { type: "undoRewind"; preRewindId: string }
  /** The full list of files a checkpoint or restore point left out; answered by `skippedFiles`. */
  | { type: "requestSkippedFiles"; target: SkippedFilesTarget }
  | { type: "clearSession" }
  | { type: "interrupt" }
  /** `requestId` identifies the exact card the webview optimistically marked, since one tool call id can
   *  appear in the streaming, subagent and team stores at once. Echoed back on `toolCancelRejected`. */
  | { type: "cancelToolCall"; toolUseId: string; note?: string; requestId?: string }
  | { type: "requestMcpStatus" }
  | { type: "requestSupportedCommands" }
  | { type: "openSettings" }
  /** Opens the host's settings modal outside the chat page (desktop overlay); the section must be a SETTINGS_SECTION_IDS entry. */
  | { type: "openAppSettings"; section?: SettingsSectionId; account?: SettingsAccountId }
  /** An attached settings view's bootstrap, in place of the chat's `ready`: core re-posts the settings state the view renders. */
  | { type: "requestSettingsState" }
  /** Opens the chat's own settings.json editor; core posts openSettingsFileEditor to the chat only. */
  | { type: "openSettingsFileInChat"; scope: SettingsFileScope }
  | { type: "renameSession"; sessionId: string; newName: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "openSessionLog" }
  | { type: "openSessionPlan" }
  /** Lists the chat folder's plan files for the bind-plan overlay; core answers with planFileCandidates. */
  | { type: "requestPlanFileCandidates" }
  /** candidateId is an id core issued in the last planFileCandidates for this panel; without one core opens the OS file dialog. */
  | { type: "bindPlanToSession"; candidateId?: string }
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
  /** `toolName` is the server's own tool name; sets or removes that one entry of `damocles.mcp.toolExposure` at `scope`. */
  | { type: "mcpSetToolExposure"; serverName: string; toolName: string; exposure: McpToolExposureSetting; scope: McpToolExposureScope }
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
  | { type: "setImageGenerationEnabled"; enabled: boolean }
  | { type: "setImageGenerationModel"; model: string }
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
  | { type: "requestMemoryAudit" }
  | { type: "requestMemoryAuditSummary" }
  | { type: "startMemoryAudit" }
  | { type: "cancelMemoryAudit" }
  | { type: "applyMemoryAudit"; runId: string; accept: string[]; reject: string[] }
  | { type: "revertMemoryAudit"; runId: string }
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
  | { type: "voiceTestVoice" }
  | { type: "requestVoiceConfig" }
  | { type: "requestContextUsage" }
  | { type: "requestSubscriptionUsage" }
  | { type: "requestUsageStats"; requestId: string; query: UsageStatsQuery }
  | { type: "answerElicitation"; elicitationId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { type: "tagSession"; sessionId: string; tag: string | null }
  | { type: "sendBtw"; btwId: string; question: string }
  | { type: "cancelBtw"; btwId: string }
  /** `agentId` is the subagent record id `subagentStart` names, foreground or background. */
  | { type: "stopSubagent"; agentId: string }
  | { type: "steerAgent"; agentId: string; message: string; images?: ImageBlock[]; requestId: string }
  | { type: "requestSteerTargets" }
  | { type: "pickBrowserElement" }
  | { type: "openBrowser"; url: string }
  | { type: "openElementContext"; content: string }
  | { type: "requestTeamData"; teamId: string }
  | { type: "requestTeamDataByToolUse"; toolUseId: string }
  /** A specialist only; the lead stops with its team (`cancelTeam`). */
  | { type: "cancelTeamAgent"; teamId: string; agentId: string }
  | { type: "cancelTeam"; teamId: string }
  | { type: "requestTeamAgentData"; teamId: string; agentId: string }
  | { type: "requestToolResultImages"; requestId: string; toolUseId: string; owner: ToolResultOwner }
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
  | { type: "setDeepseekApiKey"; key: string; requestId: string }
  | { type: "clearDeepseekApiKey"; requestId: string }
  | { type: "setTypesafeApiKey"; key: string; requestId: string }
  | { type: "clearTypesafeApiKey"; requestId: string }
  | { type: "setOpenrouterApiKey"; key: string; requestId: string }
  | { type: "clearOpenrouterApiKey"; requestId: string }
  | { type: "startChatGPTOAuth" }
  | { type: "signOutChatGPT" }
  | { type: "signOutCodex" }
  | { type: "claudeSignIn"; useAllowance: boolean }
  | { type: "claudeSetBilling"; useAllowance: boolean }
  | { type: "claudeSetApiKey"; key: string }
  | { type: "claudeSignOut" }
  | { type: "extensionUiResponse"; requestId: string; value: string | boolean | null }
  | { type: "settingsFileLoad"; scope: SettingsFileScope }
  /** `baseVersion` is the `version` the editor loaded; the host refuses the save as a conflict when the file changed since. */
  | { type: "settingsFileSave"; scope: SettingsFileScope; content: string; baseVersion: string }
  | { type: "revealSettingsFile"; scope: SettingsFileScope };

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

/**
 * What the host can do for the webview. The webview's defaults equal the VS Code values, so a VS Code
 * webview renders identically before and after `hostCapabilities` arrives.
 */
export interface HostCapabilities {
  /** Local sidecar voice controls (false on macOS desktop: an ad hoc signed app gets no microphone input). */
  voice: boolean;
  /** The VS Code Speech extension path. */
  hostSpeechExtensions: boolean;
  /** A host-native settings editor exists; false routes "open settings" to the in-app settings panel. */
  hostSettingsEditor: boolean;
  /** The host shows a diff editor (checkpoint diffs). */
  diffReview: boolean;
  /** `settingsUpdate` carries `settingSources` and the settings panel shows each value's source file. */
  settingsSources: boolean;
  /** The host renders editors in the chat panel with Monaco (`editorShowDiff`, `editorOpenFile`); the lazy Monaco chunk may load. */
  monaco: boolean;
  /** The host has an active text editor whose file and selection can be attached to a prompt (`damocles.ideContext.enabled`). */
  ideContext: boolean;
  /** The host fills the design tokens with the Damocles palettes and the desktop-only `--s-*` syntax tokens; code blocks then use the Damocles Shiki theme instead of one matched to the VS Code theme. */
  damoclesTheme: boolean;
  /** The settings modal opens inside the chat page; false makes settings links post `openAppSettings`, which the host shows outside the chat. */
  settingsInPanel: boolean;
  /** The chat header offers session history (search, rename, tag, delete); false where the host lists chats elsewhere (the desktop sidebar). */
  historyInPanel: boolean;
  /** With two or more folders open, the chat header's folder label picks the chat's folder; false where the host chooses it elsewhere (the desktop Projects list). */
  folderPickerInPanel: boolean;
}

/** What the VS Code host supplies, and the webview's value until the host says otherwise. */
export const VSCODE_HOST_CAPABILITIES: Readonly<HostCapabilities> = {
  voice: true,
  hostSpeechExtensions: true,
  hostSettingsEditor: true,
  diffReview: true,
  settingsSources: false,
  monaco: false,
  ideContext: true,
  damoclesTheme: false,
  settingsInPanel: true,
  historyInPanel: true,
  folderPickerInPanel: true,
};

/** Text of a file or buffer the host shows in a chat panel editor; the host decides the body, the webview never reads files. */
export type EditorDocumentBody =
  /** `languageId` is a Monaco language id or 'plaintext'. */
  | { kind: "text"; content: string; languageId: string }
  | { kind: "tooLarge"; bytes: number; limitBytes: number }
  | { kind: "binary" }
  | { kind: "unreadable"; error: string };

export interface EditorDocument {
  name: string;
  /** Absent for in-memory text (a proposal side, an untitled buffer). */
  path?: string;
  body: EditorDocumentBody;
}

/** Files up to 10 MiB render; a larger file arrives as `tooLarge` and is never sent. */
export const EDITOR_MAX_DOCUMENT_BYTES: number = 10 * 1024 * 1024;

export type SettingsFileScope = "user" | "project" | "local";

/** Why a project or local settings file does not apply: no project is open, or the default project is untrusted. */
export type SettingsFileUnavailableReason = "noProject" | "untrusted";

/** `version` is the sha256 hex of the file's text read as UTF-8, '' when the file does not exist. `parseError` is set when the file on disk does not parse; saving is then refused. */
export type SettingsFileState =
  | { scope: SettingsFileScope; status: "ready"; path: string; exists: boolean; content: string; version: string; parseError?: string }
  | { scope: SettingsFileScope; status: "unavailable"; reason: SettingsFileUnavailableReason }
  /** The path exists but cannot be read (a directory, no permission); `error` is the reader's message. */
  | { scope: SettingsFileScope; status: "unavailable"; reason: "unreadable"; path: string; error: string };

export type SettingsFileAvailability = { available: true } | { available: false; reason: SettingsFileUnavailableReason };

/** The file a save conflicted with, read inside the save's lock; `version` is '' when the file was deleted. */
export interface SettingsFileOnDisk {
  exists: boolean;
  content: string;
  version: string;
}

/** Where a setting's effective value comes from when a `.damocles` project or local file supplies it. */
export interface SettingSource {
  scope: "project" | "local";
  /** Absolute path of the file. */
  path: string;
  /** The JSON value that file holds for the key. */
  value: unknown;
}

/** A quick-pick entry; when a select request carries `items`, the answer is the chosen item's `id`. */
export interface ExtensionUiItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** The prompt card a notification's action focuses. */
export type AttentionKind = 'approval' | 'plan' | 'question';

/** A desktop command that opens part of a chat's UI (AD11). */
export type ChatCommand = 'subscriptionUsage';

export type ExtensionToWebviewMessage =
  | { type: "assistant"; data: AssistantMessage; parentToolUseId?: string | null }
  | { type: "partial"; data: PartialMessage; parentToolUseId?: string | null }
  | { type: "done"; data: ResultMessage }
  // `isCommandEcho` marks the echo of a slash command that commits no user entry; it is always injected too.
  | { type: "userMessage"; content: string; contentBlocks?: UserContentBlock[]; correlationId: string; promptIndex: number; isInjected?: boolean; isCommandEcho?: boolean }
  | { type: "userMessageIdAssigned"; sdkMessageId: string; correlationId: string }
  | { type: "toolPending"; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string | null }
  | { type: "error"; message: string }
  | { type: "authFailure"; message: string }
  | { type: "authFailureCleared" }
  /** `stored`: the conversation has a session file, so it is what a restart restores. pi writes none before the first prompt. */
  | { type: "sessionStarted"; sessionId: string; stored?: boolean }
  /** The host bound this panel to a stored session from `resumeSession`; its history replay follows. */
  | { type: "resumeAccepted"; sessionId: string }
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
  /**
   * `settingSources` is present only when `HostCapabilities.settingsSources`; a key absent from it resolves from the user file or the default.
   * `workspaceWritable` is false in an untrusted folder, whose Workspace section core refuses to write.
   */
  | { type: "settingsUpdate"; settings: ExtensionSettings; workspaceWritable: boolean; settingSources?: Record<string, SettingSource> }
  | { type: "hostCapabilities"; capabilities: HostCapabilities }
  /**
   * Sent after each settings write; `key` is the damocles.* key the row that asked shows, `scope` and `file` where the value
   * the setter wrote now comes from. A write that left its key at the default reports the setter's home scope and no file.
   */
  | { type: "settingWriteResult"; key: string; ok: true; scope: SettingsFileScope; file?: string }
  | { type: "settingWriteResult"; key: string; ok: false; error: string }
  /** `approvalId` (purpose "proposal" only) is the `toolUseId` of the pending `requestPermission` the diff belongs to. */
  | { type: "editorShowDiff"; viewId: string; title: string; purpose: "proposal" | "checkpoint"; approvalId?: string; original: EditorDocument; modified: EditorDocument }
  /** Read-only view; `untitled` marks an in-memory buffer with no path. */
  | { type: "editorOpenFile"; viewId: string; title: string; document: EditorDocument; line?: number; untitled?: boolean }
  /** An unknown `viewId` is ignored. */
  | { type: "editorCloseView"; viewId: string }
  | { type: "settingsFileContent"; file: SettingsFileState }
  | { type: "settingsFileSaveResult"; scope: SettingsFileScope; ok: true; version: string }
  /** `onDisk` accompanies a conflict with a newer file on disk; a conflict without it (the default project moved) needs a reload. */
  | { type: "settingsFileSaveResult"; scope: SettingsFileScope; ok: false; error: string; conflict?: boolean; onDisk?: SettingsFileOnDisk }
  /** Sent only to panels that loaded `scope`, when the file changed on disk to a new `version`. */
  | { type: "settingsFileChanged"; scope: SettingsFileScope; version: string }
  | { type: "settingsFileAvailability"; files: Record<SettingsFileScope, SettingsFileAvailability> }
  | { type: "openSettingsFileEditor"; scope: SettingsFileScope }
  | { type: "supportedCommands"; commands: SlashCommandInfo[] }
  | { type: "budgetWarning"; currentSpend: number; limit: number; percentUsed: number }
  | { type: "budgetExceeded"; finalSpend: number; limit: number }
  /** `toolExposureScopes` lists the settings scopes a per-tool exposure can be saved to in this panel's folder, lowest first. */
  | ({ type: "mcpServerStatus"; servers: McpServerStatusInfo[]; mcpEnabled: boolean; configErrors: McpConfigError[]; toolExposureScopes: McpToolExposureScope[] } & McpLocalUnignoredFlag)
  | { type: "checkpointInfo"; userMessageIds: string[] }
  | { type: "togglePromptNavigator" }
  | { type: "rewindComplete"; rewindToMessageId: string; option: RewindOption; promptContent?: string; fileRewindWarning?: string }
  | { type: "rewindError"; message: string }
  | { type: "rewindUndone" }
  /** Replies to `requestSkippedFiles` with the same `target`; a failed read carries no reason, which the host logs. */
  | { type: "skippedFiles"; target: SkippedFilesTarget; files: SkippedFile[] | null }
  | { type: "toolStreaming"; messageId: string; tool: { id: string; name: string; input: Record<string, unknown> }; contentBlocks: ContentBlock[]; parentToolUseId?: string | null }
  | { type: "toolCompleted"; toolUseId: string; toolName: string; result: string; parentToolUseId?: string | null; durationMs?: number; imageCount?: number }
  /** Replies to `requestToolResultImages`; `[]` means unavailable, for any reason; read failures are logged. */
  | { type: "toolResultImages"; requestId: string; images: ImageBlock[] }
  | { type: "toolFailed"; toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolAbandoned"; toolUseId: string; toolName: string; parentToolUseId?: string | null }
  /** No live shell call matched the cancel, so the optimistic "Stopping..." state has nothing to clear it.
   *  Match on `requestId` when present, else fall back to `toolUseId`. Not an error: the ordinary case is
   *  a click landing after the call finished. */
  | { type: "toolCancelRejected"; toolUseId: string; requestId?: string }
  | { type: "toolMetadata"; toolUseId: string; metadata: Record<string, unknown> }
  /** A `stopSubagent` that stopped nothing because the agent had already finished, so its "Stopping..." state clears. */
  | { type: "subagentStopRejected"; agentId: string }
  /** A `cancelTeam` that stopped nothing because the team had already finished, so its "Stopping..." state clears. */
  | { type: "teamCancelRejected"; teamId: string }
  | { type: "subagentStart"; agentId: string; agentType: string; toolUseId?: string; isBackground?: boolean; description?: string; resumedFrom?: string }
  | { type: "subagentStop"; agentId: string; toolUseId?: string; lastAssistantMessage?: string }
  | { type: "stopInfo"; lastAssistantMessage?: string }
  | { type: "subagentModelUpdate"; agentToolId: string; model?: string; effort?: import('../effort-badge').EffortBadgeLevel }
  | { type: "subagentTemplateUpdate"; agentToolId: string; templatePath: string }
  | { type: "subagentUsageUpdate"; agentToolId: string; usage: AgentUsageTotals; dollarBilled?: boolean }
  | { type: "subagentMessagesUpdate"; agentToolId: string; messages: HistoryAgentMessage[] }
  | { type: "sessionCancelled" }
  | { type: "sessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { type: "sessionEnd"; reason: string }
  | { type: "preCompact"; trigger: CompactionTrigger }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: CompactionTrigger; summary?: string; timestamp?: number; isHistorical?: boolean; entryId?: string; billedTokens?: number; billedCost?: number }
  | { type: "compactionAborted"; trigger: CompactionTrigger; willRetry: boolean; errorMessage?: string; timestamp: number }
  | { type: "cacheMissNotice"; missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean; timestamp: number }
  | { type: "thinkingDroppedNotice"; count: number; reasons: string[]; timestamp: number }
  | { type: "compactSummary"; summary: string }
  | { type: "contextUsage"; data: ContextUsageData | null; reason?: "busy" | "noQuery" }
  | { type: "subscriptionUsage"; data: SubscriptionUsageData }
  | { type: "usageStatsProgress"; requestId: string; filesDone: number; filesTotal: number }
  | { type: "usageStats"; requestId: string; final: boolean; report: UsageStatsReport | null; error?: string }
  | { type: "contextUsageSummary"; totalTokens: number; maxTokens: number; percentage: number }
  | { type: "tokenUsageUpdate"; inputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number }
  /** The conversation's own spend over every entry in its file, abandoned branches included, and its own user prompts on the current branch. */
  | { type: "sessionUsage"; usage: AgentUsageTotals; numTurns: number }
  | { type: "rewindHistory"; prompts: RewindHistoryItem[]; restorePoints: RestorePoint[]; canFork: boolean }
  | { type: "prefillInput"; text: string }
  | { type: "userReplay"; content: string; contentBlocks?: ContentBlock[]; isSynthetic?: boolean; sdkMessageId?: string; isInjected?: boolean; isMidStream?: boolean; steerTarget?: { agentId: string; agentType?: string; description?: string }; promptIndex?: number }
  | { type: "assistantReplay"; content: string; thinking?: string; tools?: HistoryToolCall[]; contentBlocks?: ContentBlock[]; effort?: import('../effort-badge').EffortBadgeLevel }
  | { type: "errorReplay"; content: string }
  | { type: "promptHistory"; history: string[]; hasMore: boolean }
  | { type: "promptHistoryPush"; entry: string }
  | { type: "panelFocused" }
  | { type: "workspaceFiles"; files: WorkspaceFileInfo[] }
  | {
      type: "requestPermission";
      toolUseId: string;
      /** Any other tool gets the generic prompt, which shows `toolInput`. */
      toolName: string;
      toolInput: Record<string, unknown>;
      filePath?: string;
      /** Edit and Write: the change's patch with real line numbers, as its result records it (`FilePatch`). */
      patch?: string;
      patchOmitted?: import('./file-patch').FilePatchOmitted;
      command?: string;
      /** GenerateImage only: the text sent to the image model. A GenerateImage request carries no diff. */
      prompt?: string;
      /** GenerateImage only: the OpenRouter image model the call is billed for. */
      imageModel?: string;
      /** The transcript that holds the call's card; a team agent's card is in the team view, which takes no prompt status. */
      owner: PromptOwner;
      parentToolUseId?: string | null;
      editLineNumber?: number;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
    }
  /**
   * The prompt closed without the user's answer: an abort ended it, or `approvedBy`, the permission state
   * it no longer asks under, approved it. The tool's own lifecycle sets the card's status.
   */
  | { type: "permissionAutoResolved"; toolUseId: string; parentToolUseId?: string | null; approvedBy?: PromptApprover }
  | { type: "customSlashCommands"; commands: SlashCommandItem[] }
  | { type: "steerTargets"; agents: SteerTargetInfo[] }
  | { type: "customAgents"; agents: CustomAgentInfo[] }
  | { type: "messageQueued"; message: QueuedMessage }
  | { type: "queueProcessed"; messageId: string }
  | { type: "queueBatchProcessed"; messageIds: string[]; combinedContent: string; contentBlocks?: UserContentBlock[] }
  /** `returnToInput`: the chip's message was never sent, and goes back into the composer rather than away. */
  | { type: "queueCancelled"; messageId: string; returnToInput?: boolean }
  | { type: "flushedMessagesAssigned"; queueMessageIds: string[]; sdkMessageId: string }
  | ({ type: "mcpConfigUpdate"; servers: McpServerStatusInfo[]; configErrors: McpConfigError[] } & McpLocalUnignoredFlag)
  /** Rules naming renamed MCP tools in files Damocles does not rewrite; each file and rule is sent once. */
  | { type: "mcpRenamedToolRules"; notices: McpRenamedToolRuleNotice[] }
  /**
   * The outcome of one `mcpAddServer`/`mcpUpdateServer`/`mcpDeleteServer`. Sent for every attempt,
   * success or failure, so the form can stay open holding the user's typed definition until the write
   * is known to have landed — a dialog that closes on send loses everything the user entered on any
   * rejection the webview could not predict.
   */
  | { type: "mcpWriteResult"; requestId: string; ok: true }
  | { type: "mcpWriteResult"; requestId: string; ok: false; error: McpWriteErrorInfo }
  | { type: "toolStatus"; data: ToolsSnapshot }
  | { type: "imageGenerationSettings"; settings: ImageGenerationSettings }
  | { type: "projectTrust"; trusted: boolean }
  | { type: "requestQuestion"; toolUseId: string; questions: Question[]; owner: PromptOwner; parentToolUseId?: string | null }
  | { type: "requestForm"; toolUseId: string; form: FormSchema; owner: PromptOwner; parentToolUseId?: string | null }
  | { type: "ideContextUpdate"; context: IdeContextDisplayInfo | null }
  | {
      type: "requestPlanApproval";
      toolUseId: string;
      planContent: string;
      /** The call's plan version, as its result records it under `PLAN_VERSION_DETAIL_KEY`. */
      planVersion?: number;
      owner: PromptOwner;
      parentToolUseId?: string | null;
    }
  | {
      type: "requestSkillApproval";
      toolUseId: string;
      skillName: string;
      skillDescription?: string;
      owner: PromptOwner;
      parentToolUseId?: string | null;
    }
  | {
      type: "interruptRecovery";
      correlationId: string;
      promptContent: string;
    }
  | { type: "languageChange"; locale: string }
  | { type: "showPlanContent"; content: string; filePath: string }
  /** `modifiedAt` is epoch milliseconds. `listFailed` answers a listing that threw, so the overlay leaves its loading state and still offers Browse. */
  | { type: "planFileCandidates"; files: { id: string; relativePath: string; modifiedAt: number }[]; hasPlan: boolean; listFailed?: true }
  | { type: "contextWarning"; level: ContextWarningLevel }
  | { type: "autoCompactTriggering"; percentUsed: number; trigger: Exclude<CompactionTrigger, "manual"> }
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
  // `code` is set exactly when source is "audit"; the webview localizes it and logs `message`.
  | { type: "memoryError"; message: string; source?: "consolidation" | "panel" | "audit"; requestId?: string; code?: MemoryAuditErrorCode }
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
  | { type: "memoryAuditState"; state: MemoryAuditStatePayload }
  | { type: "memoryAuditProgress"; progress: MemoryAuditProgress }
  // Null when the memory store is unavailable: no banner, and nothing to report.
  | { type: "memoryAuditSummary"; summary: MemoryAuditSummary | null }
  | { type: "memoryAuditResult"; result: MemoryAuditResult }
  | { type: "memoryAuditCancelResult"; result: MemoryAuditCancelResult }
  | { type: "modelUpdate"; activeModel: string; defaultModel: string; contextWindowSize: number }
  // `switched` is set only when the panel moved to a new folder with a fresh conversation; without it the
  // message is state only, and the webview reverts any optimistic selection to `panelFolderKey`.
  | { type: "workspaceFolderUpdate"; folders: WorkspaceFolderInfo[]; panelFolderKey: string; defaultFolderKey: string; switched?: boolean }
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
  // `requestId` echoes the `steerAgent` this answers; a steer the extension sends on its own carries none.
  | { type: "subagentSteered"; agentId: string; toolUseId: string | null; agentType?: string; description?: string; message: string; images?: ImageBlock[]; requestId?: string; status: 'steered' | 'queued' | 'finished' | 'failed' | 'not-found'; team?: { teamId: string; teamTitle: string; memberName: string; role: 'lead' | 'specialist' } }
  | { type: "backgroundTaskCompleted"; taskId: string; status: 'completed' | 'failed' | 'stopped' }
  | { type: "backgroundTaskResult"; taskId: string; toolUseId: string; result: string; summary: string }
  | { type: "browserElementPicked"; element: import('./browser').ElementAttachment }
  | { type: "browserStatusUpdate"; connected: boolean }
  | { type: "teamStarted"; team: import('./team').TeamState }
  | { type: "teamPhaseUpdate"; teamId: string; phase: import('./team').TeamPhase }
  // A partial delta. An absent field means the sender has nothing new to say about it, not a reset.
  // `attempt` rides only on a launch, and an advance is what tells the card its work fields start over.
  | { type: "teamAgentStatusUpdate"; teamId: string; agentId: string; status: import('./team').TeamAgentStatus; progressSummary?: string; logFilePath?: string | null; model?: string; dollarBilled?: boolean; attempt?: number; effort?: import('../effort-badge').EffortBadgeLevel | null; stopwatch?: import('../team-stopwatch').Stopwatch }
  | { type: "teamAgentToolCall"; teamId: string; agentId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "teamMessage"; teamId: string; message: import('./team').TeamMessage }
  | { type: "teamScratchpadUpdate"; teamId: string; entry: import('./team').ScratchpadEntry }
  | { type: "teamCompleted"; teamId: string; status: 'completed' | 'failed' | 'cancelled'; result: string | null; run: import('./team').TeamRunSummary }
  | { type: "teamAgentStreamDelta"; teamId: string; agentId: string; deltaType: 'thinking' | 'text'; text: string }
  | { type: "teamAgentAssistant"; teamId: string; agentId: string; messageId: string; content: import('./team').TeamAgentContentBlock[]; timestamp: number }
  | { type: "teamAgentUserMessage"; teamId: string; agentId: string; content: string; images?: ImageBlock[]; timestamp: number }
  | { type: "teamAgentToolProgress"; teamId: string; agentId: string; toolUseId: string; output: string; outputTruncated?: boolean }
  // `metadata` is the team path's only carrier for a tool result's `details`; the other two producers emit `toolMetadata`.
  | { type: "teamAgentToolResult"; teamId: string; agentId: string; toolUseId: string; result: string; isError?: boolean; imageCount?: number; metadata?: Record<string, unknown> }
  | { type: "teamAgentUsageUpdate"; teamId: string; agentId: string; totalInputTokens: number; totalOutputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
  | { type: "teamAgentDataLoaded"; teamId: string; agentId: string; messages: import('./team').TeamAgentHistoryMessage[] }
  /** `pendingPrompts` is every unanswered prompt with its owner, in the order raised; non-empty exactly when `state` is `requires_action`. */
  | { type: "sessionStateChanged"; state: 'idle' | 'running' | 'requires_action'; sessionId: string; pendingPrompts: readonly PendingPromptOwner[] }
  // The user chose a notification's action: focus that prompt's card (a user action, so it takes focus).
  | { type: "focusAttention"; kind: AttentionKind }
  | { type: "openTeamOverlay"; teamId: string }
  // A desktop command for this chat's UI (AD11); the only path from a command to a chat.
  | { type: "runChatCommand"; command: ChatCommand }
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
  | { type: "exploreToolCall"; toolUseId: string; innerToolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "exploreCompleted"; toolUseId: string; status: 'completed' | 'failed'; result: string | null; elapsed: number; toolCount: number; model: string }
  | { type: "exploreMessagesUpdate"; toolUseId: string; messages: HistoryAgentMessage[] }
  | { type: "openaiAuthStatusChanged"; status: { chatgpt: { signedIn: boolean; expiresAt?: number }; codex: { signedIn: boolean; expiresAt?: number }; apikey: { configured: boolean } }; preferApiKey: boolean }
  | { type: "setOpenAIApiKeyAck"; requestId: string; ok: boolean; validated?: boolean; modelCount?: number; warning?: string; error?: string }
  | { type: "clearOpenAIApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "setOpenAIPreferApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "setStepfunApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearStepfunApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "stepfunAuthStatusChanged"; configured: boolean }
  | { type: "setDeepseekApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearDeepseekApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "deepseekAuthStatusChanged"; configured: boolean }
  | { type: "setTypesafeApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearTypesafeApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "typesafeAuthStatusChanged"; configured: boolean; memoryJudge: MemoryJudge }
  | { type: "setOpenrouterApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "clearOpenrouterApiKeyAck"; requestId: string; ok: boolean; error?: string }
  | { type: "openrouterAuthStatusChanged"; configured: boolean }
  | { type: "openaiChatGPTAuthStarted" }
  | { type: "openaiChatGPTAuthCompleted" }
  | { type: "openaiChatGPTAuthFailed"; error: string }
  | { type: "openaiAuthRequired"; modelValue: string }
  | { type: "claudeAuthStatusChanged"; mode: "none" | "apikey" | "allowance" | "extra" }
  | { type: "claudeAuthBusy"; busy: boolean }
  | { type: "claudeAuthCancelled" }
  | { type: "claudeAuthError"; error: string }
  | { type: "openSettingsPanel"; section?: SettingsSectionId; account?: SettingsAccountId }
  | { type: "openOpenAIAuthPanel" }
  | {
      type: "extensionUiRequest";
      requestId: string;
      kind: "select" | "confirm" | "input" | "editor";
      title: string;
      message?: string;
      options?: string[];
      /** kind "select": when present the list renders these and the answer is the item id, not the label. */
      items?: ExtensionUiItem[];
      placeholder?: string;
      prefill?: string;
      /** kind "input": masked; the value never reaches a log on either side. */
      password?: boolean;
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
