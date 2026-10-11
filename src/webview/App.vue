<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, provide } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { initLocaleMessaging } from "@/i18n";
import { onKeyStroke } from "@vueuse/core";
import { storeToRefs } from "pinia";
import VirtualizedMessageList from "./components/VirtualizedMessageList.vue";
import JumpToLatestButton from "./components/JumpToLatestButton.vue";
import ChatInput from "./components/ChatInput.vue";
import ComposerStatusStrip from "./components/composer/ComposerStatusStrip.vue";
import ChatHeader from "./components/chat-header/ChatHeader.vue";
import SessionHistoryDropdown from "./components/chat-header/SessionHistoryDropdown.vue";
import type { HeaderAction } from "./components/chat-header/headerActions";
import EmptyState from "./components/EmptyState.vue";
import PlanReadyBanner from "./components/PlanReadyBanner.vue";
import ExtensionUiDialog from "./components/ExtensionUiDialog.vue";
import { PANEL_HOST_SETTINGS } from "./components/settings/panel-host-settings";
import { Toaster } from "@/components/ui/sonner";
import McpStatusPanel from "./components/McpStatusPanel.vue";
import ToolsStatusPanel from "./components/ToolsStatusPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import BudgetWarning from "./components/BudgetWarning.vue";
import ContextWarningBanner from "./components/ContextWarningBanner.vue";
import AuthFailureBanner from "./components/AuthFailureBanner.vue";
import McpRenamedRulesBanner from "./components/McpRenamedRulesBanner.vue";
import RewindConfirmModal from "./components/RewindConfirmModal.vue";
import PermissionPrompt from "./components/PermissionPrompt.vue";
import ElicitationPrompt from "./components/ElicitationPrompt.vue";
import { useJarvisLifecycle } from "./composables/useJarvisLifecycle";
import { provideMessageListRef } from "./composables/useMessageListRef";

useJarvisLifecycle();

const VoiceFirstRunModal = defineAsyncComponent(() => import("./components/VoiceFirstRunModal.vue"));
const VoiceModelDownloadModal = defineAsyncComponent(() => import("./components/VoiceModelDownloadModal.vue"));
const VoiceModelUpgradeModal = defineAsyncComponent(() => import("./components/VoiceModelUpgradeModal.vue"));

const SubagentOverlay = defineAsyncComponent(() => import("./components/SubagentOverlay.vue"));
const DiffOverlay = defineAsyncComponent(() => import("./components/DiffOverlay.vue"));
const McpToolOverlay = defineAsyncComponent(() => import("./components/McpToolOverlay.vue"));
const ToolOverlay = defineAsyncComponent(() => import("./components/ToolOverlay.vue"));
const RewindBrowser = defineAsyncComponent(() => import("./components/RewindBrowser.vue"));
const CompactionRewindConfirm = defineAsyncComponent(() => import("./components/CompactionRewindConfirm.vue"));
const QuestionPrompt = defineAsyncComponent(() => import("./components/QuestionPrompt.vue"));
const FormPrompt = defineAsyncComponent(() => import("./components/FormPrompt.vue"));
const SettingsModal = defineAsyncComponent(() => import("./components/settings/SettingsModal.vue"));
const PlanApprovalOverlay = defineAsyncComponent(() => import("./components/PlanApprovalOverlay.vue"));
const PlanViewOverlay = defineAsyncComponent(() => import("./components/PlanViewOverlay.vue"));
const BindPlanOverlay = defineAsyncComponent(() => import("./components/BindPlanOverlay.vue"));
const ContextInjectionOverlay = defineAsyncComponent(() => import("./components/context-injection/ContextInjectionOverlay.vue"));
const ContextUsageOverlay = defineAsyncComponent(() => import("./components/ContextUsageOverlay.vue"));
const SubscriptionUsageOverlay = defineAsyncComponent(() => import("./components/SubscriptionUsageOverlay.vue"));
const UsageStatsOverlay = defineAsyncComponent(() => import("./components/usage-stats/UsageStatsOverlay.vue"));
const SkillApprovalPrompt = defineAsyncComponent(() => import("./components/SkillApprovalPrompt.vue"));
const MemoryPanel = defineAsyncComponent(() => import("./components/MemoryPanel.vue"));
const MemoryAuditOverlay = defineAsyncComponent(() => import("./components/memory-audit/MemoryAuditOverlay.vue"));
const ConsolidationOverlay = defineAsyncComponent(() => import("./components/ConsolidationOverlay.vue"));
const BackgroundTasksOverlay = defineAsyncComponent(() => import("./components/BackgroundTasksOverlay.vue"));
const TeamOverlay = defineAsyncComponent(() => import("./components/TeamOverlay.vue"));
const TeamAgentOverlay = defineAsyncComponent(() => import("./components/TeamAgentOverlay.vue"));
const CompassGraphOverlay = defineAsyncComponent(() => import("./components/CompassGraph.vue"));
const CompassSearchOverlay = defineAsyncComponent(() => import("./components/CompassSearchPanel.vue"));
const CompassValidationOverlay = defineAsyncComponent(() => import("./components/CompassValidationPanel.vue"));
const BtwAsideBubble = defineAsyncComponent(() => import("./components/BtwAsideBubble.vue"));
// The only path to Monaco: rendered solely while hostCapabilities.monaco is on, so the VS Code webview never fetches the chunk.
const EditorOverlayHost = defineAsyncComponent({
  loader: () => import("./components/editor/EditorOverlayHost.vue"),
  // Closing what asked for the editor unmounts the failed host, so the next request loads the chunk again.
  onError: (error, _retry, fail) => {
    toast.error(t("editor.loadFailed", { error: error.message }));
    fail();
    editorStore.dismissView();
  },
});
import PromptNavigator from "./components/PromptNavigator.vue";
import { useOpenSettings } from "@/composables/useOpenSettings";
import { usePlatformBridge } from "./composables/usePlatformBridge";
import { useBtwAsk } from "./composables/useBtwAsk";
import { useMessageHandler } from "./composables/message-handler";
import { useDoubleKeyStroke } from "./composables/useDoubleKeyStroke";
import { useStickToBottom } from "./composables/useStickToBottom";
import { useExpandedTool } from "./composables/useExpandedTool";
import { hasOpenOverlay } from "./composables/useOverlayEscape";
import {
  useUIStore,
  useSettingsStore,
  useSessionStore,
  usePermissionStore,
  useStreamingStore,
  useSubagentStore,
  useQuestionStore,
  useFormStore,
  useDiffStore,
  useMemoryStore,
} from "./stores";
import { usePlanViewStore } from "./stores/usePlanViewStore";
import { useBindPlanStore } from "./stores/useBindPlanStore";
import { useContextInjectionStore } from "./stores/useContextInjectionStore";
import { useContextUsageStore } from "./stores/useContextUsageStore";
import { useSubscriptionUsageStore } from "./stores/useSubscriptionUsageStore";
import { useUsageStatsStore } from "./stores/useUsageStatsStore";
import { useConsolidationStore } from "./stores/useConsolidationStore";
import { useMemoryAuditStore } from "./stores/useMemoryAuditStore";
import { useBackgroundTaskStore } from "./stores/useBackgroundTaskStore";
import { useEditorStore } from "./stores/useEditorStore";
import { useTeamStore } from "./stores/useTeamStore";
import { useCompassStore } from "./stores/useCompassStore";
import { useBtwStore } from "./stores/useBtwStore";
import { useVoiceJarvisStore } from "./stores/useVoiceJarvisStore";
import { usePromptNavigatorStore } from "./stores/usePromptNavigatorStore";
import type { PermissionMode } from "@shared/types/settings";
import type { MemoryTier } from "@shared/types/memory";
import type { ChatMessage, RewindOption, RewindHistoryItem, RestorePoint } from "@shared/types/session";
import type { UserContentBlock } from "@shared/types/content";
import type { SteerRequest } from "@/utils/steer-command";
import type { PermissionUpdate } from "@shared/types/permissions";
import type { ToolGroup } from "@shared/types/tools";
import type { McpServerConfig, McpToolExposureScope, McpToolExposureSetting } from "@shared/types/mcp";
import type { WebviewToExtensionMessage } from "@shared/types/messages";

const { postMessage } = usePlatformBridge();
const { t } = useI18n();

initLocaleMessaging(postMessage);

const uiStore = useUIStore();
const {
  isProcessing,
  showSettingsModal,
  settingsTarget,
  showMcpPanel,
  showToolsPanel,
  showMemoryPanel,
  currentRunningTool,
  showRewindTypeModal,
  showRewindBrowser,
  rewindHistoryItems,
  rewindRestorePoints,
  rewindHistoryLoading,
  rewindCanFork,
  selectedRewindItem,
  rewindMetadataLoading,
  authFailureMessage,
  retryStatus,
} = storeToRefs(uiStore);

const settingsStore = useSettingsStore();
const editorStore = useEditorStore();
const {
  currentSettings,
  mcpServers,
  mcpConfigErrors,
  mcpLocalUnignored,
  mcpToolExposureScopes,
  mcpRenamedToolRules,
  mcpConfigRevision,
  mcpWriteRequestId,
  mcpWriteError,
  mcpEnabled,
  toolsSnapshot,
  budgetWarning,
  contextWarning,
} = storeToRefs(settingsStore);

const sessionStore = useSessionStore();
const {
  selectedSessionId,
  selectedSessionDisplayName,
  storedSessions,
  hasMoreSessions,
  nextSessionsOffset,
  loadingMoreSessions,
  checkpointMessages,
  compactMarkers,
  cacheMissNotices,
  compactionAbortedNotices,
  thinkingDroppedNotices,
  sessionStats,
  isAwaitingUserAction,
} = storeToRefs(sessionStore);


const permissionStore = usePermissionStore();
const {
  currentPermission,
  pendingCount: pendingPermissionCount,
  pendingPlanApproval,
  isPlanOverlayVisible,
  pendingSkillApproval,
} = storeToRefs(permissionStore);

const streamingStore = useStreamingStore();
const { messages, streamingMessageId } = storeToRefs(streamingStore);
const { tool: expandedTool, owner: expandedToolOwner } = useExpandedTool();

const subagentStore = useSubagentStore();
const { subagents, expandedSubagent } = storeToRefs(subagentStore);

const questionStore = useQuestionStore();
const { pendingQuestion } = storeToRefs(questionStore);
const formStore = useFormStore();
const { pendingForm: pendingFormSchema } = storeToRefs(formStore);

const diffStore = useDiffStore();
const { expandedDiff } = storeToRefs(diffStore);

const memoryStore = useMemoryStore();
const { notes, observations, searchResults, hasMoreObservations, loadingObservations } =
  storeToRefs(memoryStore);

const planViewStore = usePlanViewStore();
const bindPlanStore = useBindPlanStore();
const { viewingPlan } = storeToRefs(planViewStore);

const contextInjectionStore = useContextInjectionStore();
const contextUsageStore = useContextUsageStore();
const subscriptionUsageStore = useSubscriptionUsageStore();
const usageStatsStore = useUsageStatsStore();
const consolidationStore = useConsolidationStore();
const memoryAuditStore = useMemoryAuditStore();
const backgroundTaskStore = useBackgroundTaskStore();
const teamStore = useTeamStore();
const compassStore = useCompassStore();
const btwStore = useBtwStore();
const askBtw = useBtwAsk();
const voiceJarvisStore = useVoiceJarvisStore();
const {
  firstRunRequired: voiceFirstRunRequired,
  modelDownload: voiceModelDownload,
  hasActiveDownload: voiceHasActiveDownload,
  showModelDownload: voiceShowModelDownload,
  pendingUpgrades: voicePendingUpgrades,
} = storeToRefs(voiceJarvisStore);

function handleVoiceFirstRunAccept(): void {
  postMessage({ type: "voiceAcceptFirstRunModal" });
  voiceJarvisStore.setFirstRunRequired(null);
}

function handleVoiceFirstRunCancel(): void {
  postMessage({ type: "voiceCancelFirstRunModal" });
  voiceJarvisStore.setFirstRunRequired(null);
}

function handleVoiceDownloadCancel(): void {
  postMessage({ type: "voiceCancelModelDownload" });
}

function handleVoiceLicenseOpen(url: string): void {
  postMessage({ type: "openExternalUrl", url });
}

function handleVoiceUpgradeAccept(modelIds: string[]): void {
  postMessage({ type: "voiceAcceptModelUpgrade", modelIds });
  voiceJarvisStore.clearPendingUpgrades();
}

function handleVoiceUpgradeDismiss(): void {
  postMessage({ type: "voiceDismissModelUpgrade" });
  voiceJarvisStore.clearPendingUpgrades();
}

const messageContainerRef = ref<HTMLElement | null>(null);
provide("messageScrollContainer", messageContainerRef);
const messageListRef = ref<InstanceType<typeof VirtualizedMessageList> | null>(null);
provideMessageListRef(messageListRef);
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);

const navigatorStore = usePromptNavigatorStore();
const { isOpen: isNavigatorOpen } = storeToRefs(navigatorStore);

const {
  isFollowing: isFollowingTranscript,
  scrollToBottom: followTranscript,
  jumpToLatest: jumpToLatestInTranscript,
} = useStickToBottom(messageContainerRef);

const compactMarkersList = computed(() => compactMarkers.value);

const cacheMissNoticesList = computed(() => cacheMissNotices.value);

const compactionAbortedNoticesList = computed(() => compactionAbortedNotices.value);

const thinkingDroppedNoticesList = computed(() => thinkingDroppedNotices.value);

useMessageHandler({
  chatInputRef,
  followTranscript,
});

function openRewindFlow() {
  uiStore.openRewindBrowser();
  postMessage({ type: "requestRewindHistory" });
}

function handleBubbleRewind(message: ChatMessage) {
  if (!message.sdkMessageId) return;
  uiStore.startDirectRewind(message);
  postMessage({ type: "requestRewindHistory" });
}

function handleEditAndResend(text: string) {
  navigatorStore.close();
  nextTick(() => chatInputRef.value?.setInput(text));
}

function handleNavigatorRewind(messageId: string) {
  const msg = streamingStore.messages.find((m) => m.id === messageId);
  if (!msg) return;
  navigatorStore.close();
  handleBubbleRewind(msg);
}

// Compaction entry id awaiting the legacy yes/no confirm — only checkpoint-less anchors route here.
const pendingCompactionRewindId = ref<string | null>(null);

// Boundary card + picker's checkpoint-less branch. Checkpoint-backed → full file-rewind modal (metadata
// hydrates once rewindHistory arrives); checkpoint-less → yes/no confirm.
function handleCompactionRewind(entryId: string) {
  if (checkpointMessages.value.has(entryId)) {
    const marker = compactMarkers.value.find((m) => m.entryId === entryId);
    const timestamp = marker?.timestamp ?? Date.now();
    uiStore.startDirectCompactionRewind(entryId, timestamp);
    postMessage({ type: "requestRewindHistory" });
    return;
  }
  pendingCompactionRewindId.value = entryId;
}

function handleRewindBrowserSelect(item: RewindHistoryItem) {
  // Checkpoint-backed compaction → full modal (item already enriched); checkpoint-less → close picker
  // and open the conversation-only confirm; prompt anchor keeps its flow.
  if (item.kind === "compaction") {
    if (checkpointMessages.value.has(item.messageId)) {
      uiStore.selectRewindItem(item);
      return;
    }
    uiStore.closeRewindBrowser();
    handleCompactionRewind(item.messageId);
    return;
  }
  uiStore.selectRewindItem(item);
}

function handleUndoRewind(point: RestorePoint) {
  uiStore.closeRewindBrowser();
  postMessage({ type: "undoRewind", preRewindId: point.id });
}

function confirmCompactionRewind() {
  const entryId = pendingCompactionRewindId.value;
  pendingCompactionRewindId.value = null;
  if (!entryId) return;
  // Branch the pi tree at the compaction entry's parent → a forked panel replaying the full
  // pre-compaction conversation. Conversation-only (no file restore), no prompt to prefill.
  postMessage({ type: "rewindToMessage", userMessageId: entryId, option: "fork-conversation" });
}

function cancelCompactionRewind() {
  pendingCompactionRewindId.value = null;
}

useDoubleKeyStroke("Escape", () => {
  if (isNavigatorOpen.value) return;
  if (
    !showRewindTypeModal.value &&
    !showRewindBrowser.value &&
    !showSettingsModal.value &&
    !showMcpPanel.value &&
    !showToolsPanel.value &&
    !showMemoryPanel.value
  ) {
    openRewindFlow();
  }
});

function tryDispatchBtw(content: string | UserContentBlock[]): boolean {
  if (typeof content !== "string") return false;
  const btwMatch = content.trim().match(/^\/btw\s+(.+)$/s);
  if (!btwMatch) return false;
  askBtw(btwMatch[1]!);
  return true;
}

function handleSteer({ agentId, message, images }: SteerRequest, requestId: string) {
  postMessage({ type: "steerAgent", agentId, message, ...(images.length ? { images } : {}), requestId });
}

function handleOpenSubscriptionUsage() {
  subscriptionUsageStore.requestOverlay();
}

function tryInterceptUsage(content: string | UserContentBlock[]): boolean {
  if (typeof content !== "string") return false;
  if (content.trim() !== "/usage") return false;
  handleOpenSubscriptionUsage();
  return true;
}

function tryInterceptStats(content: string | UserContentBlock[]): boolean {
  if (typeof content !== "string") return false;
  if (content.trim() !== "/stats") return false;
  usageStatsStore.openOverlay();
  return true;
}

// The webview's own slash commands; the send and queue paths both call this, so they act the same mid-turn.
function tryInterceptLocalCommand(content: string | UserContentBlock[]): boolean {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
      openRewindFlow();
      return true;
    }
    if (trimmed === "/clear") {
      postMessage({ type: "clearSession" });
      return true;
    }
    if (trimmed === "/context") {
      handleOpenContextUsage();
      return true;
    }
  }
  return tryInterceptUsage(content) || tryInterceptStats(content) || tryDispatchBtw(content);
}

function handleSendMessage(content: string | UserContentBlock[], includeIdeContext: boolean, terminalAttachmentIds: string[]) {
  if (tryInterceptLocalCommand(content)) return;

  postMessage({ type: "sendMessage", content, includeIdeContext, ...(terminalAttachmentIds.length > 0 ? { terminalAttachmentIds } : {}) });
  followTranscript();
  uiStore.setProcessing(true);
}

function handleQueueMessage(content: string | UserContentBlock[]) {
  if (tryInterceptLocalCommand(content)) return;
  postMessage({ type: "queueMessage", content });
  followTranscript();
}

function handleModeChange(mode: PermissionMode) {
  postMessage({ type: "setPermissionMode", mode });
  settingsStore.setPermissionMode(mode);
}

function handleToggleDangerouslySkipPermissions() {
  const newValue = !currentSettings.value.dangerouslySkipPermissions;
  postMessage({ type: "setDangerouslySkipPermissions", enabled: newValue });
  settingsStore.setDangerouslySkipPermissions(newValue);
}

function handleCancel() {
  postMessage({ type: "cancelSession" });
}

// The panel is cleared on the host's `resumeAccepted`, since the host refuses a conversation another panel holds.
function handleSessionSelect(sessionId: string) {
  if (!storedSessions.value.some((s) => s.id === sessionId)) return;
  postMessage({ type: "resumeSession", sessionId });
}

function handleSessionRename(sessionId: string, newName: string) {
  if (selectedSessionId.value === sessionId) {
    sessionStore.setSelectedSession(sessionId, newName);
  }
  postMessage({ type: "renameSession", sessionId, newName });
}

function handleSessionDelete(sessionId: string) {
  postMessage({ type: "deleteSession", sessionId });
}

function handleSessionTag(sessionId: string, tag: string | null) {
  postMessage({ type: "tagSession", sessionId, tag });
}

/** The session-list messages declare `selectedSessionId` as optional, so with no selection the key
 *  is omitted rather than sent as an explicit undefined. */
function selectedSessionIdField(): { selectedSessionId?: string } {
  const id = selectedSessionId.value;
  return id ? { selectedSessionId: id } : {};
}

function handleSessionLoadMore() {
  if (!hasMoreSessions.value || loadingMoreSessions.value) return;
  sessionStore.setLoadingMoreSessions(true);
  postMessage({
    type: "requestMoreSessions",
    offset: nextSessionsOffset.value,
    ...selectedSessionIdField(),
  });
}

function handleSessionSearch(query: string, offset: number = 0) {
  if (query.trim()) {
    if (offset > 0) {
      sessionStore.setLoadingMoreSessions(true);
    }
    postMessage({ type: "searchSessions", query, offset, ...selectedSessionIdField() });
  } else {
    sessionStore.setLoadingMoreSessions(true);
    postMessage({ type: "requestMoreSessions", offset: 0, ...selectedSessionIdField() });
  }
}

function handleSessionPickerOpen() {
  if (selectedSessionId.value) {
    postMessage({ type: "requestMoreSessions", offset: 0, selectedSessionId: selectedSessionId.value });
  }
}

function handleSetPermissionMode(mode: PermissionMode) {
  postMessage({ type: "setPermissionMode", mode });
  settingsStore.setPermissionMode(mode);
}

const handleOpenSettings = useOpenSettings();

function handleInvokeSignIn() {
  handleOpenSettings("accounts");
}

function handleOpenSessionLog() {
  postMessage({ type: "openSessionLog" });
}

function handleOpenPlan() {
  postMessage({ type: "openSessionPlan" });
}

function handleOpenContextUsage() {
  contextUsageStore.openOverlay();
  postMessage({ type: "requestContextUsage" });
}

function handleOpenConsolidation() {
  consolidationStore.openOverlay();
  postMessage({ type: "requestConsolidationPreview" });
}

function handleOpenBackgroundTasks() {
  backgroundTaskStore.openOverlay();
}

function handleViewContext(promptIndex: number) {
  contextInjectionStore.openOverlay(promptIndex);
  postMessage({ type: "requestContextInjection", promptIndex });
}

function handleOpenBrowser() {
  postMessage({ type: "openBrowser" });
}

function handleBindPlan() {
  // A fresh panel always has a runtime session id, so the extension's id guard can't tell "not started
  // yet" apart from a real session. An empty conversation is the reliable signal there's nothing to bind
  // a plan to — match view-plan's informational behavior with a toast instead of opening the picker.
  if (messages.value.length === 0) {
    toast.info(t("toast.noSessionToBindPlan"));
    return;
  }
  bindPlanStore.open();
  postMessage({ type: "requestPlanFileCandidates" });
}

function handleOpenAgentLog(agentId: string) {
  postMessage({ type: "openAgentLog", agentId });
}

function handleOpenMcpPanel() {
  if (uiStore.openMcpPanel()) {
    postMessage({ type: "requestMcpStatus" });
  }
}

function handleToggleMcpServer(serverName: string, enabled: boolean) {
  postMessage({ type: "toggleMcpServer", serverName, enabled });
}

function handleSetMcpEnabled(enabled: boolean) {
  postMessage({ type: "setMcpEnabled", enabled });
}

function handleSetMcpToolExposure(serverName: string, toolName: string, exposure: McpToolExposureSetting, scope: McpToolExposureScope) {
  postMessage({ type: "mcpSetToolExposure", serverName, toolName, exposure, scope });
}

function handleReconnectMcpServer(serverName: string) {
  postMessage({ type: "reconnectMcpServer", serverName });
}

function handleAuthenticateMcpServer(serverName: string) {
  postMessage({ type: "authenticateMcpServer", serverName });
}

function handleReauthenticateMcpServer(serverName: string) {
  postMessage({ type: "reauthenticateMcpServer", serverName });
}

function handleSignOutMcpServer(serverName: string) {
  postMessage({ type: "signOutMcpServer", serverName });
}

function handleReloadMcpConfig() {
  postMessage({ type: "mcpReloadConfig" });
}

/**
 * Every MCP write carries a requestId and is registered as in-flight before it is sent, so the form
 * can stay open holding what the user typed until the extension acknowledges it.
 */
function sendMcpWrite(build: (requestId: string) => WebviewToExtensionMessage) {
  const requestId = crypto.randomUUID();
  settingsStore.beginMcpWrite(requestId);
  postMessage(build(requestId));
}

function handleAddMcpServer(serverName: string, config: McpServerConfig) {
  sendMcpWrite((requestId) => ({ type: "mcpAddServer", requestId, serverName, config }));
}

function handleUpdateMcpServer(
  serverName: string,
  newServerName: string | undefined,
  config: McpServerConfig,
) {
  // `serverName` is the pre-rename name; `newServerName` is omitted entirely for an in-place edit.
  sendMcpWrite((requestId) =>
    newServerName === undefined
      ? { type: "mcpUpdateServer", requestId, serverName, config }
      : { type: "mcpUpdateServer", requestId, serverName, newServerName, config },
  );
}

function handleDeleteMcpServer(serverName: string) {
  sendMcpWrite((requestId) => ({ type: "mcpDeleteServer", requestId, serverName }));
}

function handleOpenMcpConfigFile(filePath: string, line: number | null) {
  // These files live outside the workspace (`~/.damocles/mcp.json`), which the existing openFile
  // handler already allows and documents — no second, laxer path is introduced for this.
  postMessage(line === null ? { type: "openFile", filePath } : { type: "openFile", filePath, line });
}

function handleOpenToolsPanel() {
  if (uiStore.openToolsPanel()) {
    postMessage({ type: "requestToolStatus" });
  }
}

function handleToggleTool(toolName: string, enabled: boolean) {
  settingsStore.setToolsSnapshot({
    groups: toolsSnapshot.value.groups,
    tools: toolsSnapshot.value.tools.map((tool) =>
      tool.name === toolName ? { ...tool, enabled } : tool,
    ),
  });
  postMessage({ type: "toggleTool", toolName, enabled });
}

function handleToggleToolGroup(group: ToolGroup, enabled: boolean) {
  settingsStore.setToolsSnapshot({
    groups: toolsSnapshot.value.groups.map((g) => (g.group === group ? { ...g, enabled } : g)),
    tools: toolsSnapshot.value.tools.map((tool) =>
      tool.group === group && tool.toggleable ? { ...tool, enabled } : tool,
    ),
  });
  postMessage({ type: "toggleToolGroup", group, enabled });
}

function handleTypeSelected(option: RewindOption) {
  if (option === "cancel") {
    uiStore.cancelTypeSelection();
    return;
  }

  if (selectedRewindItem.value) {
    // A compaction fork must NOT prefill the summary as a prompt — omit promptContent for compaction
    // items (only prompt anchors carry a prompt to restore).
    const isCompaction = selectedRewindItem.value.kind === "compaction";
    postMessage({
      type: "rewindToMessage",
      userMessageId: selectedRewindItem.value.messageId,
      option,
      ...(isCompaction ? {} : { promptContent: selectedRewindItem.value.content }),
    });
    uiStore.cancelRewind();
  }
  uiStore.closeRewindTypeModal();
}

function handlePermissionApproval(
  toolUseId: string,
  approved: boolean,
  options?: { acceptAll?: boolean; customMessage?: string; updatedPermissions?: PermissionUpdate[] },
) {
  // Any agent's edit prompt switches the whole chat, so every agent's later edits auto-approve.
  if (options?.acceptAll) {
    handleSetPermissionMode("acceptEdits");
  }

  // JSON round-trip to strip Vue reactive proxies before postMessage. JSON.parse is `any` by
  // definition, so the round-trip result is re-asserted as the type that went in.
  const updatedPermissions: PermissionUpdate[] | undefined = options?.updatedPermissions
    ? (JSON.parse(JSON.stringify(options.updatedPermissions)) as PermissionUpdate[])
    : undefined;

  postMessage({
    type: "approveEdit",
    toolUseId,
    approved,
    ...(options?.customMessage !== undefined && { customMessage: options.customMessage }),
    ...(updatedPermissions ? { updatedPermissions } : {}),
  });
  permissionStore.removePermission(toolUseId);
}

function handleQuestionSubmit(answers: Record<string, string>, annotations?: import("@shared/types/permissions").QuestionAnnotations) {
  if (pendingQuestion.value) {
    postMessage({
      type: "answerQuestion",
      toolUseId: pendingQuestion.value.toolUseId,
      answers,
      ...(annotations && { annotations }),
    });
    questionStore.clearQuestion();
  }
}

function handleQuestionCancel() {
  if (pendingQuestion.value) {
    postMessage({
      type: "answerQuestion",
      toolUseId: pendingQuestion.value.toolUseId,
      answers: null,
    });
    questionStore.clearQuestion();
  }
}

function handleFormSubmit(values: import("@shared/types/forms").FormValues) {
  if (formStore.pendingForm) {
    postMessage({
      type: "answerForm",
      toolUseId: formStore.pendingForm.toolUseId,
      values,
    });
    formStore.clearForm();
  }
}

function handleFormCancel() {
  if (formStore.pendingForm) {
    postMessage({
      type: "answerForm",
      toolUseId: formStore.pendingForm.toolUseId,
      values: null,
    });
    formStore.clearForm();
  }
}

function handleOpenMemoryPanel() {
  uiStore.openMemoryPanel();
}

function handleCreateMemory(payload: { tier: Exclude<MemoryTier, 'observation'>; kind: 'fact' | 'preference' | 'episode'; content: string; requestId: string }) {
  postMessage({ type: "createMemory", tier: payload.tier, kind: payload.kind, content: payload.content, requestId: payload.requestId });
}

function handleDeleteMemory(id: string) {
  postMessage({ type: "deleteMemory", id });
}

function handlePinMemory(id: string) {
  postMessage({ type: "pinMemory", id });
}

function handleUnpinMemory(id: string) {
  postMessage({ type: "unpinMemory", id });
}

function handleLoadMoreObservations() {
  if (memoryStore.loadingObservations || !memoryStore.hasMoreObservations) return;
  memoryStore.loadingObservations = true;
  postMessage({
    type: "requestMoreObservations",
    ...(memoryStore.observationCursor ? { cursor: memoryStore.observationCursor } : {}),
  });
}

function handleDismissBudgetWarning() {
  settingsStore.dismissBudgetWarning();
}

function handleDismissContextWarning() {
  if (contextWarning.value?.autoCompactTriggered) {
    postMessage({ type: "cancelAutoCompact" });
  }
  settingsStore.dismissContextWarning();
}

function handlePlanApprove(options: { approvalMode: "acceptEdits" | "manual"; clearContext?: boolean }) {
  if (!pendingPlanApproval.value) return;
  const { toolUseId } = pendingPlanApproval.value;
  streamingStore.updateToolStatus(toolUseId, "completed");
  permissionStore.storePlanApproval(toolUseId, options.approvalMode);
  postMessage({
    type: "approvePlan",
    toolUseId,
    approved: true,
    approvalMode: options.approvalMode,
    ...(options.clearContext !== undefined && { clearContext: options.clearContext }),
  });
  permissionStore.clearPendingPlanApproval();
}

function handlePlanFeedback(feedback: string) {
  if (!pendingPlanApproval.value) return;
  const toolUseId = pendingPlanApproval.value.toolUseId;
  streamingStore.updateToolStatus(toolUseId, "denied", { feedback });
  postMessage({
    type: "approvePlan",
    toolUseId,
    approved: false,
    feedback,
  });
  permissionStore.clearPendingPlanApproval();
}

function handlePlanCancel() {
  if (!pendingPlanApproval.value) return;
  const toolUseId = pendingPlanApproval.value.toolUseId;
  streamingStore.updateToolStatus(toolUseId, "denied");
  postMessage({
    type: "approvePlan",
    toolUseId,
    approved: false,
  });
  permissionStore.clearPendingPlanApproval();
}

function handlePlanDismiss() {
  permissionStore.hidePlanOverlay();
}

onKeyStroke(
  "Escape",
  (e) => {
    if (isNavigatorOpen.value) return;
    // Same document node as the overlay listeners, where their stopPropagation cannot reach this one.
    if (hasOpenOverlay()) return;
    if (pendingPlanApproval.value && !isPlanOverlayVisible.value) {
      e.stopPropagation();
      e.preventDefault();
      handlePlanCancel();
    }
  },
  { target: document },
);

function handleSkillApprove(approved: boolean, options?: { approvalMode?: "acceptEdits" | "manual"; customMessage?: string }) {
  if (!pendingSkillApproval.value) return;
  const toolUseId = pendingSkillApproval.value.toolUseId;

  if (approved) {
    streamingStore.updateToolStatus(toolUseId, "completed");
  } else {
    streamingStore.updateToolStatus(toolUseId, "denied", options?.customMessage !== undefined ? { feedback: options.customMessage } : {});
  }

  if (options?.approvalMode === "acceptEdits" && settingsStore.currentSettings.permissionMode !== "plan") {
    handleSetPermissionMode("acceptEdits");
  }

  postMessage({
    type: "approveSkill",
    toolUseId,
    approved,
    ...(options?.approvalMode !== undefined && { approvalMode: options.approvalMode }),
    ...(options?.customMessage !== undefined && { customMessage: options.customMessage }),
  });
  permissionStore.clearPendingSkillApproval();
}

const rewindMessagePreview = computed(() => {
  return selectedRewindItem.value?.content.slice(0, 100) || "";
});

// A side question is a `/btw` prompt; once one exists, the same entry reopens its answer.
function handleSideQuestion() {
  chatInputRef.value?.prependInput("/btw ");
}

const HEADER_ACTIONS: Record<HeaderAction, () => void> = {
  consolidation: handleOpenConsolidation,
  viewPlan: handleOpenPlan,
  bindPlan: handleBindPlan,
  memory: handleOpenMemoryPanel,
  browser: handleOpenBrowser,
  mcp: handleOpenMcpPanel,
  tools: handleOpenToolsPanel,
  rewind: openRewindFlow,
  sideQuestion: handleSideQuestion,
  viewAside: () => btwStore.openOverlay(),
  context: handleOpenContextUsage,
  usage: handleOpenSubscriptionUsage,
  stats: () => usageStatsStore.openOverlay(),
  settings: () => handleOpenSettings(),
  terminal: () => postMessage({ type: "toggleTerminal" }),
};

const isEmptyConversation = computed(() => messageListRef.value?.isEmpty === true);

const statusOverride = computed(() => {
  if (contextWarning.value?.autoCompactTriggered) return t('context.autoCompacting');
  if (retryStatus.value) return t('status.retrying', { attempt: retryStatus.value.attempt, max: retryStatus.value.maxAttempts });
  return undefined;
});

// A suggestion sends at once, as the reference's chips do, without touching the draft.
function handleSuggestion(prompt: string) {
  chatInputRef.value?.sendPrompt(prompt);
}

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-(--d-bg) text-(--d-text)">
    <ChatHeader @action="(action: HeaderAction) => HEADER_ACTIONS[action]()">
      <template
        v-if="settingsStore.hostCapabilities.historyInPanel"
        #history
      >
        <SessionHistoryDropdown
          :sessions="storedSessions"
          :selected-session-id="selectedSessionId"
          :selected-session-name="selectedSessionDisplayName"
          :has-more="hasMoreSessions"
          :loading="loadingMoreSessions"
          @select="handleSessionSelect"
          @rename="handleSessionRename"
          @delete="handleSessionDelete"
          @tag="handleSessionTag"
          @load-more="handleSessionLoadMore"
          @search="handleSessionSearch"
          @open="handleSessionPickerOpen"
        />
      </template>
    </ChatHeader>

    <!-- The message area is the scroll-to-bottom button's positioning context. -->
    <div class="relative min-h-0 flex-1">
      <Toaster
        position="top-right"
        :duration="4000"
      />

      <!-- Marked as the overlay return-focus region: a transcript row can be recycled away while an overlay opened from it is up. -->
      <div
        ref="messageContainerRef"
        data-overlay-return-focus
        tabindex="-1"
        class="h-full overflow-y-auto message-container outline-none"
      >
        <EmptyState
          v-if="isEmptyConversation"
          @pick="handleSuggestion"
        />
        <VirtualizedMessageList
          ref="messageListRef"
          :messages="messages"
          :streaming-message-id="streamingMessageId"
          :compact-markers="compactMarkersList"
          :cache-miss-notices="cacheMissNoticesList"
          :compaction-aborted-notices="compactionAbortedNoticesList"
          :thinking-dropped-notices="thinkingDroppedNoticesList"
          :checkpoint-messages="checkpointMessages"
          :subagents="subagents"
          @rewind="handleBubbleRewind"
          @rewind-to-compaction="handleCompactionRewind"
          @expand-subagent="subagentStore.expandSubagent"
          @view-context="handleViewContext"
        />
      </div>

      <Transition name="t-pop">
        <JumpToLatestButton
          v-if="!isFollowingTranscript && !isEmptyConversation"
          class="absolute bottom-3.5 inset-e-5 z-10"
          @click="jumpToLatestInTranscript"
        />
      </Transition>
    </div>

    <!-- The bottom dock, top to bottom as in Chat Panel.dc.html: banners, prompts, plan banner, status row, status strip, composer. -->
    <div
      class="shrink-0 pb-3.5 pt-2"
      data-testid="chat-dock"
    >
      <div class="chat-column flex flex-col gap-2">
        <TransitionGroup
          name="t-up"
          tag="div"
          class="flex flex-col gap-2 empty:hidden"
        >
          <BudgetWarning
            v-if="budgetWarning"
            key="budget"
            :current-spend="budgetWarning.currentSpend"
            :limit="budgetWarning.limit"
            :exceeded="budgetWarning.exceeded"
            @dismiss="handleDismissBudgetWarning"
          />
          <ContextWarningBanner
            v-if="contextWarning"
            key="context"
            :level="contextWarning.level"
            :auto-compact-triggered="contextWarning.autoCompactTriggered"
            @dismiss="handleDismissContextWarning"
          />
          <AuthFailureBanner
            v-if="authFailureMessage"
            key="auth"
            :message="authFailureMessage"
            @sign-in="handleInvokeSignIn"
            @dismiss="uiStore.dismissAuthFailure"
          />
          <McpRenamedRulesBanner
            v-if="mcpRenamedToolRules.length > 0"
            key="mcp-renamed"
            :notices="mcpRenamedToolRules"
            @open-file="(path: string) => handleOpenMcpConfigFile(path, null)"
            @dismiss="settingsStore.dismissMcpRenamedToolRules()"
          />
        </TransitionGroup>

        <!-- Permission Prompt (queue - shows one at a time) -->
        <Transition name="t-up">
          <PermissionPrompt
            v-if="currentPermission"
            :visible="true"
            :tool-use-id="currentPermission.toolUseId"
            :tool-name="currentPermission.toolName"
            :tool-input="currentPermission.toolInput"
            :file-path="currentPermission.filePath"
            :prompt="currentPermission.prompt"
            :image-model="currentPermission.imageModel"
            :patch="currentPermission.patch"
            :patch-omitted="currentPermission.patchOmitted"
            :command="currentPermission.command"
            :owner="currentPermission.owner"
            :agent-description="currentPermission.agentDescription"
            :suggestions="currentPermission.suggestions"
            :blocked-path="currentPermission.blockedPath"
            :decision-reason="currentPermission.decisionReason"
            :queue-position="1"
            :queue-total="pendingPermissionCount"
            @approve="(approved, options) => currentPermission && handlePermissionApproval(currentPermission.toolUseId, approved, options)"
          />
        </Transition>

        <!-- Question Prompt for AskUserQuestion tool -->
        <Transition name="t-up">
          <QuestionPrompt
            v-if="pendingQuestion"
            :visible="true"
            @submit="handleQuestionSubmit"
            @cancel="handleQuestionCancel"
          />
        </Transition>

        <!-- Input Form Prompt for BrowserRequestInput tool -->
        <Transition name="t-up">
          <FormPrompt
            v-if="pendingFormSchema"
            :visible="true"
            @submit="handleFormSubmit"
            @cancel="handleFormCancel"
          />
        </Transition>

        <!-- Webview-bridged dialogs for pi-extension ctx.ui.* (US-026) -->
        <ExtensionUiDialog />

        <!-- Skill Approval Prompt for Skill tool -->
        <Transition name="t-up">
          <SkillApprovalPrompt
            v-if="pendingSkillApproval"
            :visible="true"
            :skill-name="pendingSkillApproval.skillName"
            :skill-description="pendingSkillApproval.skillDescription"
            @approve="handleSkillApprove"
          />
        </Transition>

        <!-- Elicitation Prompt for MCP server input requests -->
        <ElicitationPrompt />

        <PlanReadyBanner />

        <StatusBar
          :is-processing="isProcessing"
          :awaiting-user-action="isAwaitingUserAction"
          :current-tool-name="currentRunningTool ?? undefined"
          :status-override="statusOverride"
          :active-hooks="uiStore.activeHooks"
        />

        <ComposerStatusStrip
          :stats="sessionStats"
          @open-log="handleOpenSessionLog"
          @open-context-usage="handleOpenContextUsage"
          @open-background-tasks="handleOpenBackgroundTasks"
        />

        <ChatInput
          ref="chatInputRef"
          :is-processing="isProcessing"
          :permission-mode="currentSettings.permissionMode"
          :dangerously-skip-permissions="currentSettings.dangerouslySkipPermissions"
          :settings-open="showSettingsModal"
          @send="handleSendMessage"
          @queue="handleQueueMessage"
          @steer="handleSteer"
          @cancel="handleCancel"
          @change-mode="handleModeChange"
          @toggle-dangerously-skip-permissions="handleToggleDangerouslySkipPermissions"
        />
      </div>
    </div>

    <SettingsModal
      v-if="showSettingsModal && settingsStore.hostCapabilities.settingsInPanel"
      :host="PANEL_HOST_SETTINGS"
      :footer="{ kind: 'hostSettings' }"
      backdrop="blur"
      :target="settingsTarget ?? undefined"
      @closed="uiStore.closeSettingsModal()"
      @open-host-settings="postMessage({ type: 'openSettings' })"
    />

    <Transition
      name="t-overlay"
      appear
    >
      <McpStatusPanel
        v-if="showMcpPanel"
        :servers="mcpServers"
        :config-errors="mcpConfigErrors"
        :local-mcp-unignored="mcpLocalUnignored"
        :tool-exposure-scopes="mcpToolExposureScopes"
        :config-revision="mcpConfigRevision"
        :mcp-enabled="mcpEnabled"
        :mcp-write-in-flight="mcpWriteRequestId !== null"
        :mcp-write-error="mcpWriteError"
        @close="uiStore.closeMcpPanel()"
        @toggle="handleToggleMcpServer"
        @toggle-enabled="handleSetMcpEnabled"
        @set-tool-exposure="handleSetMcpToolExposure"
        @reconnect="handleReconnectMcpServer"
        @authenticate="handleAuthenticateMcpServer"
        @reauthenticate="handleReauthenticateMcpServer"
        @sign-out="handleSignOutMcpServer"
        @reload-config="handleReloadMcpConfig"
        @trust-project="postMessage({ type: 'setProjectTrusted' })"
        @add-server="handleAddMcpServer"
        @update-server="handleUpdateMcpServer"
        @delete-server="handleDeleteMcpServer"
        @open-file="handleOpenMcpConfigFile"
      />
    </Transition>

    <!-- Memory Panel (full-screen overlay) -->
    <Transition
      name="t-overlay"
      appear
    >
      <MemoryPanel
        v-if="showMemoryPanel"
        :notes="notes"
        :observations="observations"
        :search-results="searchResults"
        :has-more-observations="hasMoreObservations"
        :loading-observations="loadingObservations"
        @close="uiStore.closeMemoryPanel()"
        @create="handleCreateMemory"
        @delete="handleDeleteMemory"
        @pin="handlePinMemory"
        @unpin="handleUnpinMemory"
        @load-more-observations="handleLoadMoreObservations"
      />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <MemoryAuditOverlay
        v-if="memoryAuditStore.isOverlayOpen"
        @close="memoryAuditStore.closeOverlay()"
      />
    </Transition>

    <Transition
      name="t-overlay"
      appear
    >
      <ToolsStatusPanel
        v-if="showToolsPanel"
        :snapshot="toolsSnapshot"
        @close="uiStore.closeToolsPanel()"
        @toggle="handleToggleTool"
        @toggle-group="handleToggleToolGroup"
        @trust-project="postMessage({ type: 'setProjectTrusted' })"
      />
    </Transition>

    <!-- Rewind Type Modal (pick rewind type first) -->
    <RewindConfirmModal
      :visible="showRewindTypeModal"
      :can-fork="rewindCanFork"
      :kind="selectedRewindItem?.kind"
      :message-preview="rewindMessagePreview"
      :files-affected="selectedRewindItem?.filesAffected"
      :files="selectedRewindItem?.files"
      :lines-changed="selectedRewindItem?.linesChanged"
      :skipped="selectedRewindItem?.skipped"
      :not-rewindable="selectedRewindItem?.notRewindable"
      :checkpoint-id="selectedRewindItem?.messageId"
      :loading-metadata="rewindMetadataLoading"
      @confirm="handleTypeSelected"
      @cancel="uiStore.cancelTypeSelection"
      @open-rewind-diff="(path: string) => {
        const userMessageId = selectedRewindItem?.messageId;
        if (userMessageId) {
          postMessage({ type: 'openRewindDiff', filePath: path, userMessageId });
        } else {
          postMessage({ type: 'openFile', filePath: path });
        }
      }"
    />

    <!-- Rewind Browser (pick which message to rewind to) -->
    <Transition
      name="t-overlay"
      appear
    >
      <RewindBrowser
        v-if="showRewindBrowser"
        :prompts="rewindHistoryItems"
        :restore-points="rewindRestorePoints"
        :is-loading="rewindHistoryLoading"
        @select="handleRewindBrowserSelect"
        @undo="handleUndoRewind"
        @close="uiStore.closeRewindBrowser"
      />
    </Transition>

    <!-- Compaction rewind confirmation (shared by the boundary card and the rewind picker) -->
    <CompactionRewindConfirm
      :open="pendingCompactionRewindId !== null"
      @confirm="confirmCompactionRewind"
      @cancel="cancelCompactionRewind"
    />

    <!-- Subagent Overlay (full-screen) -->
    <Transition
      name="t-overlay"
      appear
    >
      <SubagentOverlay
        v-if="expandedSubagent"
        :subagent="expandedSubagent"
        :streaming="expandedSubagent ? subagentStore.getSubagentStreaming(expandedSubagent.id) : undefined"
        @close="subagentStore.collapseSubagent"
        @open-log="handleOpenAgentLog"
      />
    </Transition>

    <!-- Tool Overlay (full-screen) — MCP tools and built-in tools use dedicated overlays -->
    <Transition
      name="t-overlay"
      appear
    >
      <McpToolOverlay
        v-if="expandedTool && expandedTool.name.startsWith('mcp__')"
        :tool="expandedTool"
        :owner="expandedToolOwner"
        @close="uiStore.collapseTool"
      />
      <ToolOverlay
        v-else-if="expandedTool"
        :tool="expandedTool"
        :owner="expandedToolOwner"
        @close="uiStore.collapseTool"
      />
    </Transition>

    <!-- Diff Overlay (full-screen) -->
    <Transition
      name="t-overlay"
      appear
    >
      <DiffOverlay
        v-if="expandedDiff"
        :diff="expandedDiff"
        @close="diffStore.collapseDiff"
      />
    </Transition>

    <!-- Monaco editor overlays (desktop) -->
    <EditorOverlayHost
      v-if="settingsStore.hostCapabilities.monaco && editorStore.hasOpenOverlay"
      @decide="(toolUseId: string, approved: boolean) => handlePermissionApproval(toolUseId, approved)"
    />

    <!-- Plan Approval Overlay (full-screen) -->
    <Transition
      name="t-overlay"
      appear
    >
      <PlanApprovalOverlay
        v-if="pendingPlanApproval && isPlanOverlayVisible"
        :plan-content="pendingPlanApproval.planContent"
        @approve="handlePlanApprove"
        @feedback="handlePlanFeedback"
        @dismiss="handlePlanDismiss"
      />
    </Transition>

    <!-- Plan View Overlay (read-only, full-screen) -->
    <Transition
      name="t-overlay"
      appear
    >
      <PlanViewOverlay
        v-if="viewingPlan"
        :plan-content="viewingPlan"
        @close="planViewStore.closePlanView"
      />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <BindPlanOverlay
        v-if="bindPlanStore.isOpen"
        @close="bindPlanStore.close()"
      />
    </Transition>

    <!-- Context Injection Overlay -->
    <Transition
      name="t-overlay"
      appear
    >
      <ContextInjectionOverlay
        v-if="contextInjectionStore.isOverlayOpen"
        @close="contextInjectionStore.closeOverlay()"
      />
    </Transition>

    <!-- Context Usage Overlay -->
    <Transition
      name="t-overlay"
      appear
    >
      <ContextUsageOverlay
        v-if="contextUsageStore.isOverlayOpen"
        @close="contextUsageStore.closeOverlay()"
      />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <SubscriptionUsageOverlay
        v-if="subscriptionUsageStore.isOverlayOpen"
        @close="subscriptionUsageStore.closeOverlay()"
      />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <UsageStatsOverlay
        v-if="usageStatsStore.isOverlayOpen"
        @close="usageStatsStore.closeOverlay()"
      />
    </Transition>

    <Transition
      name="t-overlay"
      appear
    >
      <ConsolidationOverlay
        v-if="consolidationStore.isOverlayOpen"
        @close="consolidationStore.closeOverlay()"
      />
    </Transition>

    <!-- Background Tasks Overlay -->
    <Transition
      name="t-overlay"
      appear
    >
      <BackgroundTasksOverlay
        v-if="backgroundTaskStore.isOverlayOpen"
        @close="backgroundTaskStore.closeOverlay()"
      />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <TeamOverlay v-if="teamStore.isOverlayOpen" />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <TeamAgentOverlay v-if="teamStore.isAgentOverlayOpen" />
    </Transition>

    <Transition
      name="t-overlay"
      appear
    >
      <CompassGraphOverlay v-if="compassStore.activePanel === 'graph'" />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <CompassSearchOverlay v-if="compassStore.activePanel === 'search'" />
    </Transition>
    <Transition
      name="t-overlay"
      appear
    >
      <CompassValidationOverlay v-if="compassStore.activePanel === 'validate'" />
    </Transition>

    <!-- Voice First-Run Modal (privacy disclosure) -->
    <Transition
      name="t-overlay"
      appear
    >
      <VoiceFirstRunModal
        v-if="voiceFirstRunRequired"
        :reason="voiceFirstRunRequired"
        @accept="handleVoiceFirstRunAccept"
        @cancel="handleVoiceFirstRunCancel"
      />
    </Transition>

    <!-- Voice Model Download Modal -->
    <Transition
      name="t-overlay"
      appear
    >
      <VoiceModelDownloadModal
        v-if="voiceShowModelDownload"
        :downloads="voiceModelDownload"
        @hide="voiceJarvisStore.hideModelDownload()"
        @cancel="handleVoiceDownloadCancel"
        @open-license="handleVoiceLicenseOpen"
      />
    </Transition>

    <!-- Voice Model Upgrade Modal -->
    <Transition
      name="t-overlay"
      appear
    >
      <VoiceModelUpgradeModal
        v-if="voicePendingUpgrades.length > 0 && !voiceHasActiveDownload"
        :upgrades="voicePendingUpgrades"
        @accept="handleVoiceUpgradeAccept"
        @dismiss="handleVoiceUpgradeDismiss"
        @open-license="handleVoiceLicenseOpen"
      />
    </Transition>

    <Transition
      name="t-overlay"
      appear
    >
      <PromptNavigator
        v-if="isNavigatorOpen"
        @edit-and-resend="handleEditAndResend"
        @rewind="handleNavigatorRewind"
      />
    </Transition>

    <!-- Btw Aside Overlay -->
    <Transition
      name="t-overlay"
      appear
    >
      <BtwAsideBubble
        v-if="btwStore.isOverlayOpen && btwStore.aside"
        :aside="btwStore.aside"
        @close="btwStore.closeOverlay()"
        @dismiss="
          () => {
            if (btwStore.aside?.isStreaming) postMessage({ type: 'cancelBtw', btwId: btwStore.aside.id });
            btwStore.dismissAside();
          }
        "
      />
    </Transition>
  </div>
</template>
