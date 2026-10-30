import type { UserContentBlock, ContentBlock, HistoryToolCall, HistoryAgentMessage, ImageBlock } from './content';
import type { ChatAttachmentInfo } from './chat-attachment';
import type {
  McpConfigError,
  McpRenamedToolRuleNotice,
  McpResourceRow,
  McpResourceTemplateRow,
  McpServerConfig,
  McpServerStatusInfo,
  McpToolExposureScope,
  McpToolExposureSetting,
  McpWriteErrorInfo,
} from './mcp';
import type { SlashCommandInfo, SlashCommandItem, CustomAgentInfo, WorkspaceFileInfo } from './commands';
import type { Question, PermissionUpdate, QuestionAnnotations, PromptOwner, PendingPromptOwner, PromptApprover } from './permissions';
import type { FormSchema, FormValues } from './forms';
import type { PermissionMode, ExtensionSettings, ModelInfo, AccountInfo, ContextWarningLevel, AutoCompactConfig, AssetSourcePrecedence, CacheWarmingMode, EffortLevel, PanelThinkingState, TeamRole, MemoryJudge, ClassifierProvider, ClassifierCredential, ImageGenerationSettings, ProviderSignInState } from './settings';
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
  ToolAbandonReason,
} from './session';
import type { SubscriptionUsageData } from './usage';
import type { UsageStatsQuery, UsageStatsReport } from './usage-stats';
import type { SteerTargetInfo } from './subagents';
import type { AgentUsageTotals } from '../usage-accounting';
import type { MemoryTier, MemoryEntry, SearchQuery, SearchResult, UserProfile, ObservationCursor } from './memory';
import { ACCOUNT_PROVIDER_NAMES, type AccountProviderId, type ExternalKeySource, type KeyProviderId, type ProviderCredentialActive, type SignInProviderId } from '../settings-sections';
import type { ModelVendor } from '../model-vendor';
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

import type { VoiceProvider, VoiceConfig, VoiceMode, VoiceRuntimeStatus } from './voice';
import type { CompassIndexStatus, CompassGraphData, CompassSearchResult, CompassBlastRadiusResult, CompassNodeKind, CompassValidationResult } from './compass';
import type { ToolsSnapshot, ToolGroup } from './tools';
import type { WorkspaceFolderInfo } from './workspace-folders';
import type { SettingsAccountId, SettingsSectionId } from '../settings-sections';
import type { LocalizedText } from '../localized-text';

// A pi provider id as a credential ask or a run's token note names it; main's user relays and the overlay refuse any other form.
export const PROVIDER_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Proper nouns, never translated; any other provider shows its id.
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  "openai-codex": "ChatGPT",
  openai: "OpenAI",
  "google-gemini-cli": "Gemini",
  ...ACCOUNT_PROVIDER_NAMES,
};

// Re-exported from ./memory (its true home) so existing transport-layer imports keep working.
export type { ObservationCursor } from './memory';

export type WebviewToExtensionMessage =
  | { type: "log"; message: string }
  // terminalAttachmentIds: pending attachments (terminal output, commits, MCP resources) sent with the message; absent when none are pending
  // sessionId: the conversation the webview showed at send (its last `sessionStarted`), null while it showed none; core refuses a send for another
  | { type: "sendMessage"; content: string | UserContentBlock[]; sessionId: string | null; includeIdeContext?: boolean; terminalAttachmentIds?: string[] }
  | { type: "removeTerminalAttachment"; id: string }
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
  | { type: "setDefaultThinkingDisabled"; disabled: boolean }
  | { type: "setDefaultEffort"; effort: EffortLevel | null; model: string }
  | { type: "setTeamRoleModel"; role: TeamRole; model: string }
  | { type: "setTeamRoleEffort"; role: TeamRole; effort: EffortLevel | null }
  | { type: "setBackgroundModel"; model: string }
  | { type: "setBackgroundEffort"; effort: EffortLevel | null }
  | { type: "setMemoryJudge"; judge: string }
  | { type: "setMemoryJudgeEffort"; effort: EffortLevel | null }
  | { type: "setBudgetLimit"; budgetUsd: number | null }
  | { type: "setTaskBudget"; budget: number | null }
  | { type: "setAutoCompact"; config: AutoCompactConfig }
  | { type: "setCacheWarming"; mode: CacheWarmingMode }
  | { type: "setSubagentsMaxConcurrent"; count: number }
  | { type: "setShowCacheMissNotices"; enabled: boolean }
  | { type: "setShowThinkingDroppedNotices"; enabled: boolean }
  | { type: "setAssetSourcePrecedence"; precedence: AssetSourcePrecedence }
  | { type: "setMemoryAutoExtract"; enabled: boolean }
  | { type: "setMemoryProfile"; enabled: boolean }
  | { type: "setBrowserHeadless"; headless: boolean }
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
  /** "Continue with my sign-in", sent only on its click on a `signInRequest` card: the turn re-pins to this view's device. */
  | { type: "continueWithMySignIn"; requestId: string }
  /** `requestId` identifies the exact card the webview optimistically marked, since one tool call id can
   *  appear in the streaming, subagent and team stores at once. Echoed back on `toolCancelRejected`. */
  | { type: "cancelToolCall"; toolUseId: string; note?: string; requestId?: string }
  | { type: "requestMcpStatus" }
  | { type: "requestSupportedCommands" }
  /**
   * Opens the host's settings. VS Code filters its settings editor to `query`, a `damocles.` setting key, or to every
   * Damocles setting; the desktop app opens its settings modal, whose search box stays the user's, so it ignores `query`.
   */
  | { type: "openSettings"; query?: string }
  /** Opens the host's settings modal outside the chat page (desktop overlay); the section must be a SETTINGS_SECTION_IDS entry. */
  | { type: "openAppSettings"; section?: SettingsSectionId; account?: SettingsAccountId }
  /** The chat header's Terminal toggle, posted only when `HostCapabilities.windowLayout`; the host runs its Toggle Terminal command. */
  | { type: "toggleTerminal" }
  /** The header counter's click, posted only when `HostCapabilities.chatReview`: the host opens the chat's review tab (D60). */
  | { type: "openChatReview"; scope: ChatReviewScope }
  /** The composer's worktree controls (D30), posted only after a `worktreeState`; core re-checks the chat's phase. */
  | { type: "worktreeAction"; action: WorktreeAction }
  /** Hand off (D61): moves an idle chat between its project folder and its worktree; core re-checks that it is idle. */
  | { type: "chatMove"; to: ChatPlace }
  /** An attached settings view's bootstrap, in place of the chat's `ready`: core re-posts the settings state the view renders. */
  | { type: "requestSettingsState" }
  /** Opens the scope's settings file in the host's editor (desktop: an editor pane tab saved under settings-file-editor's rules).
   *  `key`: a setting key whose line the editor shows, as VS Code's "Edit in settings.json" does. */
  | { type: "openSettingsFileInChat"; scope: SettingsFileScope; key?: string }
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
  /** A file dropped on the composer with FILE_DRAG_MIME (src/shared/file-drag.ts); core confines it and answers with insertMention. */
  | { type: "mentionDropped"; projectKey: string; relativePath: string }
  | { type: "openFile"; filePath: string; line?: number }
  | { type: "openSystemPrompt" }
  | { type: "openMcpToolInfo"; piName: string }
  | { type: "openRewindDiff"; filePath: string; userMessageId: string }
  | { type: "openExternalUrl"; url: string }
  | { type: "requestCustomSlashCommands" }
  | { type: "requestCustomAgents" }
  /** `sessionId` as `sendMessage`'s. */
  | { type: "queueMessage"; content: string | UserContentBlock[]; sessionId: string | null }
  | { type: "cancelQueuedMessage"; messageId: string }
  | { type: "toggleMcpServer"; serverName: string; enabled: boolean }
  | { type: "setMcpEnabled"; enabled: boolean }
  /** `toolName` is the server's own tool name; sets or removes that one entry of `damocles.mcp.toolExposure` at `scope`. */
  | { type: "mcpSetToolExposure"; serverName: string; toolName: string; exposure: McpToolExposureSetting; scope: McpToolExposureScope }
  /** Sets or removes the server's entry of `damocles.mcp.resourceExposure` at `scope`. */
  | { type: "mcpSetResourceExposure"; serverName: string; exposure: McpToolExposureSetting; scope: McpToolExposureScope }
  // The MCP panel's resource picker (D13: the user's own browse and attach, which resource exposure never restricts).
  // Each request gets one reply with its requestId; omitting `cursor` asks for the first page.
  | { type: "requestMcpResources"; requestId: string; serverName: string; cursor?: string }
  | { type: "requestMcpResourceTemplates"; requestId: string; serverName: string; cursor?: string }
  | { type: "requestMcpResourceChildren"; requestId: string; serverName: string; uri: string }
  // `context` holds the template's other variables the user has filled in.
  | { type: "requestMcpResourceCompletion"; requestId: string; serverName: string; template: string; argument: string; value: string; context: Record<string, string> }
  // name and mimeType are the listed row's, for the chip; core reads the resource only when the message is sent.
  | { type: "attachMcpResource"; requestId: string; serverName: string; uri: string; name: string; mimeType?: string }
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
  | { type: "retrySetAsideTurns" }
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
  // `consent`: the user accepted the first-run dialog Settings opened for this install.
  | { type: "voiceRuntimeInstall"; consent?: true }
  | { type: "voiceRuntimeCancel" }
  | { type: "requestVoiceConfig" }
  | { type: "requestContextUsage" }
  | { type: "requestSubscriptionUsage" }
  | { type: "requestUsageStats"; requestId: string; query: UsageStatsQuery }
  | { type: "answerElicitation"; elicitationId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { type: "tagSession"; sessionId: string; tag: string | null }
  /** `sessionId` as `sendMessage`'s. */
  | { type: "sendBtw"; btwId: string; question: string; sessionId: string | null }
  | { type: "cancelBtw"; btwId: string }
  /** `agentId` is the subagent record id `subagentStart` names, foreground or background. */
  | { type: "stopSubagent"; agentId: string }
  | { type: "steerAgent"; agentId: string; message: string; images?: ImageBlock[]; requestId: string }
  | { type: "requestSteerTargets" }
  | { type: "pickBrowserElement" }
  | { type: "openBrowser" }
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
  | { type: "setExploreModel"; model: string }
  | { type: "setExploreEffort"; effort: EffortLevel | null }
  | { type: "setOpenAIApiKey"; key: string; requestId: string }
  | { type: "clearOpenAIApiKey"; requestId: string }
  | { type: "getOpenAIAuthStatus" }
  | { type: "setOpenAIPreferApiKey"; preferApiKey: boolean; requestId: string }
  | { type: "setProviderPreferApiKey"; provider: KeyProviderId; preferApiKey: boolean; requestId: string }
  | { type: "setProviderApiKey"; provider: KeyProviderId; key: string; requestId: string }
  | { type: "clearProviderApiKey"; provider: KeyProviderId; requestId: string }
  | { type: "providerSignIn"; provider: SignInProviderId }
  /** Carries what the user typed for a sign-in prompt (a code or a domain); never log it. Core drops input over 8 KB. */
  | { type: "providerSignInAnswer"; provider: SignInProviderId; input: string }
  /** Core opens the https URI it holds for the provider's flow; the webview never opens a URL. */
  | { type: "providerSignInOpenPage"; provider: SignInProviderId }
  /** Core copies the code of the provider's device-code flow to the clipboard; the code never goes through the webview's clipboard. */
  | { type: "providerSignInCopyCode"; provider: SignInProviderId }
  | { type: "providerSignInCancel"; provider: SignInProviderId }
  | { type: "providerSignOut"; provider: SignInProviderId }
  | { type: "setModelPickerProvider"; provider: ModelVendor; shown: boolean; requestId: string }
  | { type: "startChatGPTOAuth" }
  | { type: "signOutChatGPT" }
  | { type: "signOutCodex" }
  | { type: "claudeSignIn"; useAllowance: boolean }
  | { type: "claudeSetBilling"; useAllowance: boolean }
  | { type: "claudeSetApiKey"; key: string }
  | { type: "claudeSignOut" }
  /** The redirect URL or code the user pasted while a sign-in waits for the browser; carries an auth code, never log it. */
  | { type: "claudeSignInPaste"; input: string }
  | { type: "claudeSignInCancel" }
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
  /** The host renders approval diffs in the chat panel with Monaco (`editorShowDiff`); the lazy Monaco chunk may load. */
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
  /** The composer accepts a file dragged from the host's file views (FILE_DRAG_MIME) and posts mentionDropped; the empty state then says so. */
  fileMentionDrop: boolean;
  /** The host window has a layout grid with a terminal pane; the chat header shows a Terminal toggle that posts `toggleTerminal`. */
  windowLayout: boolean;
  /** The host opens a chat's review tab (D60); the chat header shows the `chatChanges` counter, which posts `openChatReview`. */
  chatReview: boolean;
  /** Worktree chats (D30, D61): core posts `worktreeState` and accepts `worktreeAction` and `chatMove`. */
  worktrees: boolean;
  /** False: the chat's host refuses YOLO (a remote host's policy for the viewing client), the YOLO control is hidden and core answers a change with `permissionModeRefused`. */
  bypassPermissions: boolean;
}

/** Where a worktree-capable chat works (D61). */
export type ChatPlace = "project" | "worktree";

export const WORKTREE_PHASES = ["none", "pending", "creating", "settingUp", "setupFailed", "createFailed", "ready", "deleted"] as const;
/** none: a project-folder chat with no worktree; pending: opted in, nothing created yet; deleted: the chat is read-only. */
export type WorktreePhase = (typeof WORKTREE_PHASES)[number];

export const WORKTREE_ACTIONS = ["cancelOptIn", "sendNow", "retry", "runInProjectFolder", "newChatInProject", "showSetupTerminal", "newChatInWorktree"] as const;
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

/** A chat's worktree state (D30, D61), sent only when `HostCapabilities.worktrees`. */
export interface WorktreeStateData {
  phase: WorktreePhase;
  place: ChatPlace;
  /** Idle, writable, and with a worktree or a trusted git project to create one in. */
  canHandOff: boolean;
  branch?: string;
  /** The branch checked out in the project folder. */
  baseBranch?: string;
  /** Uncommitted files the opt-in brings along (D63). */
  uncommittedCount?: number;
  /** Commits on `baseBranch` the worktree lacks. */
  behind?: number;
  /** `baseBranch` no longer holds the worktree's base commit. */
  targetRewritten?: boolean;
  /** The failed setup's exit code (phase setupFailed). */
  exitCode?: number;
  /** Why creation failed (phase createFailed): git's own words as written, or Damocles' refusal. */
  error?: LocalizedText;
  /** The project's display name; present whenever the chat has a worktree or a pending opt-in. */
  projectName?: string;
  /** Other chats of the project whose latest worktree entry places them in this chat's worktree; absent when 0. */
  sharedWith?: number;
  /** The setup command running now; `index` is 1-based (phase settingUp). */
  setupStep?: { command: string; index: number; total: number };
  /** The first prompt held while the worktree is created and set up (every holding phase, createFailed included). */
  heldPrompt?: { text: string; imageCount: number };
  /** A finish action runs on this chat's worktree; core refuses the chat's sends meanwhile. */
  finishing?: WorktreeFinishAction;
}

export type WorktreeFinishAction = "apply" | "merge" | "update" | "delete";

/**
 * heldPromptWaiting: a send while the first prompt waits for its worktree; worktreeFinishing: a send while a finish action
 * runs on the chat's worktree; heldPromptKept: a held first prompt that will not be sent (the chat left its opt-in, or a
 * draft the host kept across an unload or a quit); mcpResourceUnavailable: an attached MCP resource could not be sent (the
 * message's `detail` says which and why); modelSignInRequired: no signed-in model can run; modelUnavailable: the chat has
 * no model it can run, or its plan no longer includes the chat's model (`detail` says why); promptRejected: pi refused the
 * prompt before storing it, and the failure core sent with it says why: an `authFailure` card in the dock, else an error row
 * in the transcript; sendInProgress: another send, a turn or a compaction held the chat; queueRunEnded, queueBudgetStopped,
 * queueNoRuntime: a queued message core refused because the run it was typed for ended, because the budget stop is winding
 * the turn down, or because no agent session holds the chat.
 */
export type PromptReturnReason = "heldPromptWaiting" | "worktreeFinishing" | "heldPromptKept" | "mcpResourceUnavailable" | "conversationChanged" | "modelSignInRequired" | "modelUnavailable" | "promptRejected" | "sendInProgress" | "queueRunEnded" | "queueBudgetStopped" | "queueNoRuntime";

/** Why a provider call failed on its account's credential (`authFailure`, `errorReplay`, `btwError`). */
export type AuthFailureReason = "rejected" | "noApiAccess" | "missing";

/** A provider call that failed on an account's credential: the Accounts row, and why. */
export interface AuthFailure { account: SettingsAccountId; reason: AuthFailureReason }

/** A chat review's scope (D60): the whole chat, or only its latest turn. */
export type ChatReviewScope = "chat" | "turn";

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
  fileMentionDrop: false,
  windowLayout: false,
  chatReview: false,
  worktrees: false,
  bypassPermissions: true,
};

/** Text of a file or buffer the host shows in a chat panel editor; the host decides the body, the webview never reads files. */
export type EditorDocumentBody =
  /** `languageId` is a Monaco language id or 'plaintext'. */
  | { kind: "text"; content: string; languageId: string }
  | { kind: "tooLarge"; bytes: number; limitBytes: number }
  | { kind: "binary" }
  | { kind: "notAFile" }
  /** `error` is the system's own words for the failure. */
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

export type SettingsFileAvailability = { available: true } | { available: false; reason: SettingsFileUnavailableReason };

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
export const CHAT_COMMANDS = [
  'contextUsage',
  'subscriptionUsage',
  'usageStatistics',
  'mcpServers',
  'tools',
  'memory',
  'rewind',
  'sideQuestion',
  'openSessionLog',
  'viewSessionPlan',
] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

/** One queued message of a send that combined several: its id and the text and images it put back. */
export interface QueuedPart {
  messageId: string;
  content: UserContentBlock[];
}

export type ExtensionToWebviewMessage =
  | { type: "assistant"; data: AssistantMessage; parentToolUseId?: string | null }
  | { type: "partial"; data: PartialMessage; parentToolUseId?: string | null }
  /** A failed model call pi re-runs: the webview removes the assistant message `messageId` (its `partial`/`assistant` id), which a reload omits too. `parentToolUseId` names the nested agent whose transcript holds it, as on `error` and `statusUpdate`. */
  | { type: "assistantRetracted"; messageId: string; parentToolUseId?: string }
  | { type: "done"; data: ResultMessage }
  // `isCommandEcho` marks the echo of a slash command that commits no user entry; it is always injected too.
  | { type: "userMessage"; content: string; contentBlocks?: UserContentBlock[]; terminalAttachments?: ChatAttachmentInfo[]; correlationId: string; promptIndex: number; isInjected?: boolean; isCommandEcho?: boolean }
  | { type: "userMessageIdAssigned"; sdkMessageId: string; correlationId: string }
  | { type: "toolPending"; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string | null }
  /** `parentToolUseId` names the nested agent the error belongs to: a subagent's `Agent` call id or a team agent's id. */
  | { type: "error"; message: LocalizedText; parentToolUseId?: string }
  /**
   * `account`: the Accounts row whose credential the provider refused. `noApiAccess`: xAI answered 402, the account lacks API
   * access. `missing`: pi had no credential for the call, so the provider was never asked.
   */
  | ({ type: "authFailure"; message: string } & AuthFailure)
  /** With `account`, only that account's card clears: its credential changed. Without, every card clears. */
  | { type: "authFailureCleared"; account?: SettingsAccountId }
  /** `stored`: the conversation has a session file, so it is what a restart restores. pi writes none before the first prompt. */
  | { type: "sessionStarted"; sessionId: string; stored?: boolean }
  /**
   * The host bound this panel to a stored session from `resumeSession`; its history replay follows. `continued`: the panel
   * goes on with the conversation it shows (a hand-off, D61), so the composer and its draft stay.
   */
  | { type: "resumeAccepted"; sessionId: string; continued?: true }
  /** `elapsedMs`: how long the open turn has run, sent by a live snapshot so a joining or reloaded view's clock matches a view that watched. */
  | { type: "processing"; isProcessing: boolean; elapsedMs?: number }
  | { type: "storedSessions"; sessions: StoredSession[]; hasMore?: boolean; nextOffset?: number; isFirstPage?: boolean }
  /** `sessionId`: the stored conversation whose replay follows, which a send before its `sessionStarted` names; absent, the panel shows none. */
  | { type: "sessionCleared"; pendingMessage?: { content: string; correlationId: string }; sessionId?: string }
  | { type: "conversationCleared" }
  | { type: "sessionRenamed"; sessionId: string; newName: string }
  | { type: "sessionDeleted"; sessionId: string }
  | { type: "notification"; message: LocalizedText; notificationType: string }
  | { type: "accountInfo"; data: AccountInfo }
  | { type: "availableModels"; models: ModelInfo[] }
  | { type: "systemInit"; data: SystemInitData }
  /**
   * `settingSources` is present only when `HostCapabilities.settingsSources`; a key absent from it resolves from the user file or the default.
   * `workspaceWritable` is false in an untrusted folder, whose Workspace section core refuses to write.
   * `writableKeys` goes only to a settings view attached with a scope tab: the keys that tab may write, which it lists.
   */
  | { type: "settingsUpdate"; settings: ExtensionSettings; workspaceWritable: boolean; settingSources?: Record<string, SettingSource>; writableKeys?: string[] }
  | { type: "hostCapabilities"; capabilities: HostCapabilities }
  /** Core refused a permission change: YOLO on a host whose policy refuses it, or a mode core does not know. */
  | { type: "permissionModeRefused"; mode: string; reason: "remote-host" | "unknown-mode" }
  /**
   * Sent after each settings write; `key` is the damocles.* key the row that asked shows, `scope` and `file` where the value
   * the setter wrote now comes from. A write that left its key at the default reports the setter's home scope and no file.
   */
  | { type: "settingWriteResult"; key: string; ok: true; scope: SettingsFileScope; file?: string }
  | { type: "settingWriteResult"; key: string; ok: false; error: LocalizedText }
  /** An approval diff only (D15): `approvalId` is the `toolUseId` of the pending `requestPermission` the diff belongs to. Every other diff opens in the host's editor. */
  | { type: "editorShowDiff"; viewId: string; title: LocalizedText; purpose: "proposal"; approvalId: string; original: EditorDocument; modified: EditorDocument }
  /** An unknown `viewId` is ignored. */
  | { type: "editorCloseView"; viewId: string }
  | { type: "settingsFileAvailability"; files: Record<SettingsFileScope, SettingsFileAvailability> }
  | { type: "supportedCommands"; commands: SlashCommandInfo[] }
  | { type: "budgetWarning"; currentSpend: number; limit: number; percentUsed: number }
  | { type: "budgetExceeded"; finalSpend: number; limit: number }
  /** `toolExposureScopes` lists the settings scopes a per-tool exposure can be saved to in this panel's folder, lowest first. */
  | ({ type: "mcpServerStatus"; servers: McpServerStatusInfo[]; mcpEnabled: boolean; configErrors: McpConfigError[]; toolExposureScopes: McpToolExposureScope[] } & McpLocalUnignoredFlag)
  // Replies to the resource picker's requests; `error` is the localized reason a request failed, with its lists empty.
  | { type: "mcpResources"; requestId: string; resources: McpResourceRow[]; nextCursor?: string; error?: LocalizedText }
  | { type: "mcpResourceTemplates"; requestId: string; templates: McpResourceTemplateRow[]; nextCursor?: string; error?: LocalizedText }
  // notDirectory: the read returned content under the URI itself, so the row is a resource to attach
  | { type: "mcpResourceChildren"; requestId: string; children: McpResourceRow[]; error?: LocalizedText; notDirectory?: true }
  // No values from a server without the `completions` capability or on a failed request.
  | { type: "mcpResourceCompletion"; requestId: string; values: string[] }
  // refused: the localized reason nothing was attached
  | { type: "mcpResourceAttached"; requestId: string; refused?: LocalizedText }
  | { type: "checkpointInfo"; userMessageIds: string[] }
  | { type: "togglePromptNavigator" }
  | { type: "rewindComplete"; rewindToMessageId: string; option: RewindOption; promptContent?: string; fileRewindWarning?: string }
  | { type: "rewindError"; message: LocalizedText }
  | { type: "rewindUndone" }
  /** Replies to `requestSkippedFiles` with the same `target`; a failed read carries no reason, which the host logs. */
  | { type: "skippedFiles"; target: SkippedFilesTarget; files: SkippedFile[] | null }
  | { type: "toolStreaming"; messageId: string; tool: { id: string; name: string; input: Record<string, unknown> }; contentBlocks: ContentBlock[]; parentToolUseId?: string | null }
  | { type: "toolCompleted"; toolUseId: string; toolName: string; result: string; parentToolUseId?: string | null; durationMs?: number; imageCount?: number }
  /** Replies to `requestToolResultImages`; `[]` means unavailable, for any reason; read failures are logged. */
  | { type: "toolResultImages"; requestId: string; images: ImageBlock[] }
  | { type: "toolFailed"; toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; parentToolUseId?: string | null; durationMs?: number }
  | { type: "toolAbandoned"; toolUseId: string; toolName: string; parentToolUseId?: string | null; reason: ToolAbandonReason }
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
  | { type: "preCompact"; trigger: CompactionTrigger }
  | { type: "compactBoundary"; preTokens: number; postTokens?: number; trigger: CompactionTrigger; summary?: string; timestamp?: number; isHistorical?: boolean; entryId?: string; billedTokens?: number; billedCost?: number }
  | { type: "compactionAborted"; trigger: CompactionTrigger; willRetry: boolean; errorMessage?: string; timestamp: number }
  | { type: "cacheMissNotice"; missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean; timestamp: number }
  | { type: "thinkingDroppedNotice"; count: number; reasons: string[]; timestamp: number }
  | { type: "compactSummary"; summary: string }
  | { type: "contextUsage"; data: ContextUsageData | null; reason?: "busy" | "noQuery" }
  | { type: "subscriptionUsage"; data: SubscriptionUsageData }
  | { type: "usageStatsProgress"; requestId: string; filesDone: number; filesTotal: number }
  | { type: "usageStats"; requestId: string; final: boolean; report: UsageStatsReport | null; error?: LocalizedText }
  | { type: "contextUsageSummary"; totalTokens: number; maxTokens: number; percentage: number }
  | { type: "tokenUsageUpdate"; inputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number }
  /** The conversation's own spend over every entry in its file, abandoned branches included, and its own user prompts on the current branch. */
  | { type: "sessionUsage"; usage: AgentUsageTotals; numTurns: number }
  | { type: "rewindHistory"; prompts: RewindHistoryItem[]; restorePoints: RestorePoint[]; canFork: boolean }
  | { type: "prefillInput"; text: string }
  // desktop: text the host puts in the composer after its draft, which it never replaces (the Graph's Explain Changes)
  | { type: "composerAppend"; text: string }
  /** A prompt core did not send goes back into the composer, text and images; `reason` says why. */
  // detail: localized text the reason alone cannot carry; account: the Accounts row settings open at, whose sign-in lets the
  // chat's model run (modelSignInRequired, modelUnavailable) or whose credential failed (promptRejected, the `authFailure`
  // card's account); correlationId: the transcript's echo of the prompt, which the transcript drops; parts: the queued
  // messages a send of several combined, whose text `content` joins, each for the view that queued it.
  | { type: "promptReturned"; content: UserContentBlock[]; reason: PromptReturnReason; detail?: LocalizedText; account?: SettingsAccountId; correlationId?: string; parts?: QueuedPart[] }
  | { type: "userReplay"; content: string; contentBlocks?: ContentBlock[]; terminalAttachments?: ChatAttachmentInfo[]; isSynthetic?: boolean; sdkMessageId?: string; isInjected?: boolean; isMidStream?: boolean; steerTarget?: { agentId: string; agentType?: string; description?: string }; promptIndex?: number; timestamp?: number }
  | { type: "assistantReplay"; content: string; thinking?: string; tools?: HistoryToolCall[]; contentBlocks?: ContentBlock[]; effort?: import('../effort-badge').EffortBadgeLevel }
  /** `authFailure`: the call failed on that account's credential, refused or missing, which the live view showed as its card. */
  | { type: "errorReplay"; content: LocalizedText; authFailure?: AuthFailure }
  | { type: "promptHistory"; history: string[]; hasMore: boolean }
  | { type: "promptHistoryPush"; entry: string }
  | { type: "panelFocused" }
  | { type: "workspaceFiles"; files: WorkspaceFileInfo[] }
  /** Insert `@<display> ` at the composer caret, exactly as an @ autocomplete file pick does; `path` is the absolute path core resolved inside the chat's folder. */
  | { type: "insertMention"; path: string; display: string }
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
  /**
   * `messageId`: a queued chip's id, or the correlation id of a prompt pi queued into the running run.
   * `returnToInput`: the message was never sent, and goes back into the composer rather than away.
   * `sentAs`: the correlation id of the send that took the message's text, with the other messages queued beside it.
   */
  | { type: "queueCancelled"; messageId: string; returnToInput?: boolean; sentAs?: string }
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
  /**
   * A turn waits, while its pinned device is not attached, for that device's `provider` sign-in (a pi provider id, Sign-in
   * needed), a prompt of kind `signIn`; every view showing it belongs to another device, so it offers "Continue with my sign-in".
   */
  | { type: "signInRequest"; requestId: string; provider: string }
  /** The wait ended: a push from the pinned device, a continue, or Stop. */
  | { type: "signInResolved"; requestId: string }
  | { type: "ideContextUpdate"; context: IdeContextDisplayInfo | null }
  // the composer's pending attachments (terminal output, commits, MCP resources), whole list, on every change; focusComposer: the user just added one
  | { type: "terminalAttachmentsUpdate"; attachments: ChatAttachmentInfo[]; focusComposer?: true }
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
      /** The typed text and images, for a prompt sent with images. */
      contentBlocks?: UserContentBlock[];
      /** As `promptReturned`'s: the queued messages a send of several combined. */
      parts?: QueuedPart[];
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
  | { type: "memoryError"; message: LocalizedText; source?: "consolidation" | "panel" | "audit"; requestId?: string; code?: MemoryAuditErrorCode }
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
  | { type: "profileSectionError"; scope: "project" | "global"; section: "static" | "dynamic"; message: LocalizedText }
  | { type: "consolidationPendingCount"; count: number; setAside: number }
  | { type: "consolidationPreview"; candidates: PendingConsolidationCandidate[] }
  // `pass` (from 1) and `runSoFar` (the run's result over its ended passes) ride only on `running: true`, sent at every pass start and on overlay-open replay.
  | { type: "consolidationRunning"; running: boolean; pass?: number; runSoFar?: ConsolidationResult }
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
  | { type: "transcriptionError"; message: LocalizedText }
  | { type: "voiceConfigUpdate"; config: VoiceConfig; hasApiKey: boolean }
  | { type: "voiceRuntimeStatus"; status: VoiceRuntimeStatus }
  | { type: "voiceSidecarStatus"; state: "stopped" | "loading" | "ready" | "error" | "restarting"; device?: "cuda" | "cpu"; vramMbFree?: number; modelsLoaded?: string[]; message?: LocalizedText }
  | { type: "voiceWakeDetected"; confidence: number }
  | { type: "voiceWakeAborted"; reason: "no-speech" | "user-cancel" }
  | { type: "voiceVadStarted" }
  | { type: "voiceVadEnded" }
  | { type: "voiceTranscriptFinal"; text: string; durationMs: number }
  | { type: "voiceTtsAudioChunk"; chunkBase64: string; sampleRate: number }
  | { type: "voiceTtsDone" }
  | { type: "voiceMicUnavailable"; reason: "denied" | "stolen" | "no-device" }
  | { type: "voiceModelDownloadProgress"; modelId: string; bytesReceived: number; bytesTotal: number; status: "downloading" | "verifying" | "done" | "error"; message?: LocalizedText }
  | { type: "voiceModelDownloadAllDone" }
  | { type: "voiceModelDownloadCancelled" }
  | { type: "voiceModelUpgradeAvailable"; upgrades: { modelId: string; description: string; installedVersion: string; newVersion: string; bytesDelta: number; totalBytes: number; licenseUrl: string; license: string; gated: boolean }[] }
  | { type: "voiceFirstRunRequired"; reason: "missing-runtime" | "missing-models" | "first-time" }
  | { type: "voiceFilesSizeUpdate"; bytes: number }
  | { type: "voiceCpuFallbackActive"; reason: "no-cuda" | "low-vram" | "user-pref" | "cuda-oom-fallback" | "tts-unloaded" }
  | { type: "voiceTurnLost"; reason: "sidecar-crash" | "timeout" }
  /** With `parentToolUseId`, a `ready` ends that nested agent's retry wait and nothing else. */
  | { type: "statusUpdate"; status: "compacting" | "ready"; permissionMode?: string; parentToolUseId?: string }
  /** pi is waiting out the backoff before re-sending a failed model call; `attempt` of `maxAttempts` retries. A `ready` status, sent when the retried call starts or the retry ends, ends it. `parentToolUseId` names the nested agent waiting. */
  | { type: "statusUpdate"; status: "retrying"; attempt: number; maxAttempts: number; parentToolUseId?: string }
  /** A stopped nested agent whose run outlasted `WIND_DOWN_NOTICE_MS` winding down, and what pi awaits; null once the run settled. Display only. */
  | { type: "statusUpdate"; status: "windingDown"; windDown: import('./wind-down').AgentWindDown | null; parentToolUseId: string }
  /** A subagent waiting for a free slot under `damocles.subagents.maxConcurrent`; false once its run starts. Display only. */
  | { type: "statusUpdate"; status: "queued"; queued: boolean; parentToolUseId: string }
  | { type: "taskStarted"; taskId: string; toolUseId?: string; description: string; taskType?: string; isBackground?: boolean }
  | { type: "taskNotification"; taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; summary: string; outputFile: string | null; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "toolProgress"; toolUseId: string; toolName: string; parentToolUseId: string | null; elapsedTimeSeconds: number; taskId?: string; output?: string; outputTruncated?: boolean }
  | { type: "toolUseSummary"; summary: string; precedingToolUseIds: string[] }
  | { type: "hookLifecycle"; hookId: string; hookName: string; hookEvent: string; phase: "started" | "progress" | "response"; output?: string; exitCode?: number; outcome?: "success" | "error" | "cancelled" }
  | { type: "configChange"; source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'; filePath?: string }
  | { type: "taskProgress"; taskId: string; toolUseId?: string; description: string; summary?: string; lastToolName?: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }
  | { type: "requestElicitation"; elicitationId: string; serverName: string; message: string; mode: 'form' | 'url'; url?: string; requestedSchema?: Record<string, unknown> }
  | { type: "sessionTagged"; sessionId: string; tag: string | null }
  | { type: "btwStreaming"; btwId: string; text: string }
  | { type: "btwComplete"; btwId: string; text: string }
  /**
   * `authFailure`: the aside's call failed on that account's credential, shown as the transcript's notice with `message` behind
   * Details, except for `missing`, whose `message` is pi's and never shown.
   */
  | { type: "btwError"; btwId: string; message: LocalizedText; authFailure?: AuthFailure }
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
  // `result` is what the settle recorded in `agent-completed`, so the card matches a reload.
  | { type: "teamAgentStatusUpdate"; teamId: string; agentId: string; status: import('./team').TeamAgentStatus; description?: string | null; task?: string | null; progressSummary?: string; logFilePath?: string | null; model?: string; dollarBilled?: boolean; attempt?: number; effort?: import('../effort-badge').EffortBadgeLevel | null; stopwatch?: import('../team-stopwatch').Stopwatch; result?: string | null }
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
  // `streaming`: a running member's open message so far, which replaces what the page streams for it
  | { type: "teamAgentDataLoaded"; teamId: string; agentId: string; messages: import('./team').TeamAgentHistoryMessage[]; streaming?: { text: string; thinking: string; isThinkingPhase: boolean } }
  /**
   * `pendingPrompts` is every unanswered prompt with its owner, in the order raised; non-empty exactly when `state` is `requires_action`.
   * `windDown` is present while the main chat's stopped run outlasts `WIND_DOWN_NOTICE_MS` winding down. Display only.
   */
  | { type: "sessionStateChanged"; state: 'idle' | 'running' | 'requires_action'; sessionId: string; pendingPrompts: readonly PendingPromptOwner[]; windDown?: import('./wind-down').AgentWindDown }
  // The user chose a notification's action: focus that prompt's card (a user action, so it takes focus).
  | { type: "focusAttention"; kind: AttentionKind }
  | { type: "openTeamOverlay"; teamId: string }
  // A desktop command for this chat's UI (AD11); the only path from a command to a chat.
  | { type: "runChatCommand"; command: ChatCommand }
  // Whether the window shows its terminal pane, and Toggle Terminal's shortcut as the platform writes it, for the chat header's
  // Terminal toggle (HostCapabilities.windowLayout).
  | { type: "terminalShown"; shown: boolean; shortcut: string }
  // What the chat changed (D60), sent only when HostCapabilities.chatReview: lines added and removed over its files, and the
  // number of files; all zero hides the counter.
  | { type: "chatChanges"; added: number; removed: number; files: number }
  // The chat's worktree state (D30, D61); its one publisher is the session's SessionWorktree (publish, and publishStored for
  // the place a stored file gives before the session starts).
  | ({ type: "worktreeState" } & WorktreeStateData)
  // A resumed or restored chat has no worktree state to show (an untrusted project, or no repository source control has
  // open); it answers a webview waiting for the place, as worktreeState does.
  | { type: "noWorktreeState" }
  | { type: "compassStatusUpdate"; status: CompassIndexStatus }
  | { type: "compassBuildProgress"; current: number; total: number; phase: 'build' | 'postprocess' | 'serialize' }
  | { type: "compassSearchResults"; results: CompassSearchResult[] }
  | { type: "compassGraphData"; data: CompassGraphData }
  | { type: "compassBlastRadiusData"; data: CompassBlastRadiusResult }
  | { type: "compassBlastRadiusDismissed" }
  | { type: "compassValidationResult"; data: CompassValidationResult }
  | { type: "openaiAuthStatusChanged"; status: { chatgpt: { signedIn: boolean; expiresAt?: number }; codex: { signedIn: boolean; expiresAt?: number }; apikey: { configured: boolean } }; preferApiKey: boolean; active?: ProviderCredentialActive }
  | { type: "setOpenAIApiKeyAck"; requestId: string; ok: boolean; validated?: boolean; modelCount?: number; warning?: LocalizedText; error?: LocalizedText }
  | { type: "clearOpenAIApiKeyAck"; requestId: string; ok: boolean; error?: LocalizedText }
  | { type: "setOpenAIPreferApiKeyAck"; requestId: string; ok: boolean; error?: LocalizedText }
  | { type: "setProviderPreferApiKeyAck"; provider: KeyProviderId; requestId: string; ok: boolean; error?: LocalizedText }
  | { type: "setProviderApiKeyAck"; provider: KeyProviderId; requestId: string; ok: boolean; error?: LocalizedText }
  | { type: "clearProviderApiKeyAck"; provider: KeyProviderId; requestId: string; ok: boolean; error?: LocalizedText }
  | { type: "providerSignInState"; provider: SignInProviderId; state: ProviderSignInState }
  | { type: "providerSignInCopyCodeAck"; provider: SignInProviderId; ok: boolean }
  | { type: "setModelPickerProviderAck"; provider: ModelVendor; requestId: string; ok: boolean }
  /** `configured`: a key is in the host secret store. `external`: where pi's credential comes from when Damocles did not apply it. `signedIn`: `auth.json` holds an oauth credential. `active` is absent when a daemon's core reports it. */
  | { type: "providerAuthStatusChanged"; provider: AccountProviderId; configured: boolean; external: ExternalKeySource | null; signedIn: boolean; signedInExpiresAt?: number; preferApiKey: boolean; active?: ProviderCredentialActive }
  /** `classifierCredentials`: whether each classifier provider's credential can serve a Memory judge choice. */
  | { type: "memoryJudgeStatus"; memoryJudge: MemoryJudge; classifierCredentials: Record<ClassifierProvider, ClassifierCredential> }
  | { type: "openaiChatGPTAuthStarted" }
  | { type: "openaiChatGPTAuthCompleted" }
  | { type: "openaiChatGPTAuthFailed"; error: LocalizedText }
  | { type: "openaiAuthRequired"; modelValue: string }
  | { type: "claudeAuthStatusChanged"; mode: "none" | "apikey" | "allowance" | "extra" }
  | { type: "claudeAuthBusy"; busy: boolean }
  | { type: "claudeAuthCancelled" }
  | { type: "claudeAuthError"; error: LocalizedText }
  /** True while a sign-in waits for the browser to return and accepts a pasted redirect URL instead. */
  | { type: "claudeSignInWaiting"; waiting: boolean }
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
