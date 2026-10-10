import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "./types/messages";

// Compiles only while every listed type is a member of its message union.
type Within<T extends U, U> = T;

/**
 * Core-to-chat messages the settings view consumes. While a view is attached to a chat, core copies every message of
 * these types to it as well. The webview's settings handlers are a Record over this list plus SETTINGS_VIEW_PROMPTS.
 */
export const SETTINGS_VIEW_MESSAGES = [
  "settingsUpdate",
  "settingWriteResult",
  "hostCapabilities",
  "accountInfo",
  "availableModels",
  "modelUpdate",
  "panelThinkingUpdate",
  "workspaceFolderUpdate",
  "projectTrust",
  "autoCompactConfigUpdate",
  "settingsFileAvailability",
  "mcpServerStatus",
  "toolStatus",
  "imageGenerationSettings",
  "voiceConfigUpdate",
  "voiceFilesSizeUpdate",
  "openaiAuthStatusChanged",
  "setOpenAIApiKeyAck",
  "clearOpenAIApiKeyAck",
  "setOpenAIPreferApiKeyAck",
  "openaiChatGPTAuthStarted",
  "openaiChatGPTAuthCompleted",
  "openaiChatGPTAuthFailed",
  "claudeAuthStatusChanged",
  "claudeAuthBusy",
  "claudeAuthCancelled",
  "claudeAuthError",
  "claudeSignInWaiting",
  "stepfunAuthStatusChanged",
  "setStepfunApiKeyAck",
  "clearStepfunApiKeyAck",
  "deepseekAuthStatusChanged",
  "setDeepseekApiKeyAck",
  "clearDeepseekApiKeyAck",
  "typesafeAuthStatusChanged",
  "setTypesafeApiKeyAck",
  "clearTypesafeApiKeyAck",
  "openrouterAuthStatusChanged",
  "setOpenrouterApiKeyAck",
  "clearOpenrouterApiKeyAck",
] as const;

export type SettingsViewMessageType = Within<(typeof SETTINGS_VIEW_MESSAGES)[number], ExtensionToWebviewMessage["type"]>;

/**
 * Host prompts the view renders. These are never copied by type, which would also hand it PiSession dialogs:
 * webview-prompts.ts redirects its own host prompts to an attached view and nothing else does.
 */
export const SETTINGS_VIEW_PROMPTS = ["extensionUiRequest", "extensionUiCancel"] as const;

export type SettingsViewPromptType = Within<(typeof SETTINGS_VIEW_PROMPTS)[number], ExtensionToWebviewMessage["type"]>;

export const SETTINGS_VIEW_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>(SETTINGS_VIEW_MESSAGES);

/**
 * Webview-to-core messages an attached settings view may send. Core runs each with the chat's authority, so this list
 * holds settings requests only: no `ready`, no permission or PiSession dialog answers, and no opener that takes a path
 * (`voiceOpenModelsFolder` reveals only the voice models folder).
 */
export const SETTINGS_VIEW_REQUESTS = [
  "requestSettingsState",
  "setActiveModel",
  "setDefaultModel",
  "setPanelWorkspaceFolder",
  "setDefaultWorkspaceFolder",
  "setPanelThinkingDisabled",
  "setPanelEffort",
  "setDefaultThinkingDisabled",
  "setDefaultEffort",
  "setTeamRoleModel",
  "setTeamRoleEffort",
  "setBackgroundModel",
  "setBackgroundEffort",
  "setMemoryJudge",
  "setMemoryJudgeEffort",
  "setBudgetLimit",
  "setTaskBudget",
  "setAutoCompact",
  "setCacheWarming",
  "setPermissionMode",
  "setDefaultPermissionMode",
  "setDefaultDangerouslySkipPermissions",
  "setIdeContextEnabled",
  "setMcpEnabled",
  "toggleToolGroup",
  "setImageGenerationEnabled",
  "setImageGenerationModel",
  "setVoiceProvider",
  "setVoiceApiKey",
  "deleteVoiceApiKey",
  "setVoiceLanguage",
  "setVoiceMode",
  "setVoiceWakeWordSensitivity",
  "setVoiceTtsEnabled",
  "setVoiceTtsVoice",
  "setVoiceLocalGpu",
  "setVoiceEndOfTurnSilenceMs",
  "setVoiceMaxUtteranceMs",
  "setVoiceAutoSubmit",
  "setVoiceDiagnostics",
  "voiceRedownloadModels",
  "voiceOpenModelsFolder",
  "voiceFreeDiskSpace",
  "voiceRemoveAllFiles",
  "voiceTestVoice",
  "setExploreModel",
  "setExploreEffort",
  "setOpenAIApiKey",
  "clearOpenAIApiKey",
  "setOpenAIPreferApiKey",
  "startChatGPTOAuth",
  "signOutChatGPT",
  "signOutCodex",
  "setStepfunApiKey",
  "clearStepfunApiKey",
  "setDeepseekApiKey",
  "clearDeepseekApiKey",
  "setTypesafeApiKey",
  "clearTypesafeApiKey",
  "setOpenrouterApiKey",
  "clearOpenrouterApiKey",
  "claudeSignIn",
  "claudeSetBilling",
  "claudeSetApiKey",
  "claudeSignOut",
  "claudeSignInPaste",
  "claudeSignInCancel",
  "extensionUiResponse",
  "openSettingsFileInChat",
  "setCheckpointRetentionDays",
] as const;

export type SettingsViewRequestType = Within<(typeof SETTINGS_VIEW_REQUESTS)[number], WebviewToExtensionMessage["type"]>;

export const SETTINGS_VIEW_REQUEST_TYPES: ReadonlySet<string> = new Set<string>(SETTINGS_VIEW_REQUESTS);
