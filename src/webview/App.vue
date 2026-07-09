<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, provide } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { initLocaleMessaging } from "@/i18n";
import { onKeyStroke } from "@vueuse/core";
import { storeToRefs } from "pinia";
import VirtualizedMessageList from "./components/VirtualizedMessageList.vue";
import ChatInput from "./components/ChatInput.vue";
import SessionStats from "./components/SessionStats.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import { Toaster } from "@/components/ui/sonner";
import McpStatusIndicator from "./components/McpStatusIndicator.vue";
import McpStatusPanel from "./components/McpStatusPanel.vue";
import ToolsStatusIndicator from "./components/ToolsStatusIndicator.vue";
import ToolsStatusPanel from "./components/ToolsStatusPanel.vue";
import SubagentIndicator from "./components/SubagentIndicator.vue";
import StatusBar from "./components/StatusBar.vue";
import BudgetWarning from "./components/BudgetWarning.vue";
import ContextWarningBanner from "./components/ContextWarningBanner.vue";
import AuthFailureBanner from "./components/AuthFailureBanner.vue";
import RewindConfirmModal from "./components/RewindConfirmModal.vue";
import SessionPicker from "./components/SessionPicker.vue";
import PermissionPrompt from "./components/PermissionPrompt.vue";
import ElicitationPrompt from "./components/ElicitationPrompt.vue";
import TaskListCard from "./components/TaskListCard.vue";
import ConsolidationIndicator from "./components/ConsolidationIndicator.vue";
import BackgroundTasksIndicator from "./components/BackgroundTasksIndicator.vue";
import TeamIndicator from "./components/TeamIndicator.vue";
import CompassIndicator from "./components/CompassIndicator.vue";
import TeamPermissionPrompt from "./components/TeamPermissionPrompt.vue";
import PromptNavigatorChip from "./components/PromptNavigatorChip.vue";
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
const ExtensionUiDialog = defineAsyncComponent(() => import("./components/ExtensionUiDialog.vue"));
const PlanApprovalOverlay = defineAsyncComponent(() => import("./components/PlanApprovalOverlay.vue"));
const PlanViewOverlay = defineAsyncComponent(() => import("./components/PlanViewOverlay.vue"));
const ContextInjectionOverlay = defineAsyncComponent(() => import("./components/ContextInjectionOverlay.vue"));
const ContextUsageOverlay = defineAsyncComponent(() => import("./components/ContextUsageOverlay.vue"));
const SubscriptionUsageOverlay = defineAsyncComponent(() => import("./components/SubscriptionUsageOverlay.vue"));
const SkillApprovalPrompt = defineAsyncComponent(() => import("./components/SkillApprovalPrompt.vue"));
const MemoryPanel = defineAsyncComponent(() => import("./components/MemoryPanel.vue"));
const ConsolidationOverlay = defineAsyncComponent(() => import("./components/ConsolidationOverlay.vue"));
const BackgroundTasksOverlay = defineAsyncComponent(() => import("./components/BackgroundTasksOverlay.vue"));
const TeamOverlay = defineAsyncComponent(() => import("./components/TeamOverlay.vue"));
const TeamAgentOverlay = defineAsyncComponent(() => import("./components/TeamAgentOverlay.vue"));
const CompassGraphOverlay = defineAsyncComponent(() => import("./components/CompassGraph.vue"));
const CompassSearchOverlay = defineAsyncComponent(() => import("./components/CompassSearchPanel.vue"));
const CompassValidationOverlay = defineAsyncComponent(() => import("./components/CompassValidationPanel.vue"));
const BtwAsideBubble = defineAsyncComponent(() => import("./components/BtwAsideBubble.vue"));
import PromptNavigator from "./components/PromptNavigator.vue";
import { useVSCode } from "./composables/useVSCode";
import { useMessageHandler } from "./composables/message-handler";
import { useDoubleKeyStroke } from "./composables/useDoubleKeyStroke";
import { useAutoScroll } from "./composables/useAutoScroll";
import {
  useUIStore,
  useSettingsStore,
  useSessionStore,
  usePermissionStore,
  useStreamingStore,
  useSubagentStore,
  useQuestionStore,
  useDiffStore,
  useMemoryStore,
} from "./stores";
import { useTaskStore } from "./stores/useTaskStore";
import { usePlanViewStore } from "./stores/usePlanViewStore";
import { useContextInjectionStore } from "./stores/useContextInjectionStore";
import { useContextUsageStore } from "./stores/useContextUsageStore";
import { useSubscriptionUsageStore } from "./stores/useSubscriptionUsageStore";
import { useConsolidationStore } from "./stores/useConsolidationStore";
import { useBackgroundTaskStore } from "./stores/useBackgroundTaskStore";
import { useTeamStore } from "./stores/useTeamStore";
import { useCompassStore } from "./stores/useCompassStore";
import { useBtwStore } from "./stores/useBtwStore";
import { useVoiceJarvisStore } from "./stores/useVoiceJarvisStore";
import { usePromptNavigatorStore } from "./stores/usePromptNavigatorStore";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IconGear, IconChevronDown, IconFileText, IconLink, IconBrain, IconMessageSquare, IconGlobe, IconClock } from "@/components/icons";
import type { PermissionMode, EffortLevel, AutoCompactConfig } from "@shared/types/settings";
import type { VoiceProvider, VoiceMode } from "@shared/types/voice";
import type { MemoryTier } from "@shared/types/memory";
import type { ChatMessage, RewindOption, RewindHistoryItem } from "@shared/types/session";
import type { UserContentBlock } from "@shared/types/content";
import type { PermissionUpdate } from "@shared/types/permissions";
import type { ToolGroup } from "@shared/types/tools";
const { postMessage, setState, getState } = useVSCode();
const { t } = useI18n();

initLocaleMessaging(postMessage);

const uiStore = useUIStore();
const {
  isProcessing,
  isAtBottom,
  showSettingsPanel,
  showMcpPanel,
  showToolsPanel,
  showMemoryPanel,
  currentRunningTool,
  showRewindTypeModal,
  showRewindBrowser,
  rewindHistoryItems,
  rewindHistoryLoading,
  rewindCanFork,
  selectedRewindItem,
  rewindMetadataLoading,
  tasksPanelCollapsed,
  authFailureMessage,
} = storeToRefs(uiStore);

const settingsStore = useSettingsStore();
const {
  currentSettings,
  availableModels,
  accountInfo,
  mcpServers,
  mcpEnabled,
  toolsSnapshot,
  budgetWarning,
  contextWarning,
  activeModel,
  defaultModel,
  panelThinking,
  panelThinkingModel,
  defaultThinking,
  defaultThinkingModel,
  voiceConfig,
  voiceHasApiKey,
  exploreHasApiKey,
  exploreProvider,
  exploreModel,
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
  sessionStats,
} = storeToRefs(sessionStore);

const taskStore = useTaskStore();
const { tasks } = storeToRefs(taskStore);

const permissionStore = usePermissionStore();
const {
  currentPermission,
  pendingCount: pendingPermissionCount,
  pendingPlanApproval,
  isPlanOverlayVisible,
  pendingSkillApproval,
} = storeToRefs(permissionStore);

const streamingStore = useStreamingStore();
const { messages, streamingMessageId, expandedTool } = storeToRefs(streamingStore);

const subagentStore = useSubagentStore();
const { subagents, expandedSubagent } = storeToRefs(subagentStore);

const questionStore = useQuestionStore();
const { pendingQuestion } = storeToRefs(questionStore);

const diffStore = useDiffStore();
const { expandedDiff } = storeToRefs(diffStore);

const memoryStore = useMemoryStore();
const { notes, observations, searchResults, hasMoreObservations, loadingObservations } =
  storeToRefs(memoryStore);

const planViewStore = usePlanViewStore();
const { viewingPlan } = storeToRefs(planViewStore);

const contextInjectionStore = useContextInjectionStore();
const contextUsageStore = useContextUsageStore();
const subscriptionUsageStore = useSubscriptionUsageStore();
const consolidationStore = useConsolidationStore();
const backgroundTaskStore = useBackgroundTaskStore();
const teamStore = useTeamStore();
const compassStore = useCompassStore();
const btwStore = useBtwStore();
const voiceJarvisStore = useVoiceJarvisStore();
const {
  firstRunRequired: voiceFirstRunRequired,
  modelDownload: voiceModelDownload,
  hasActiveDownload: voiceHasActiveDownload,
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

const shouldAutoScroll = computed(() => isProcessing.value || !!streamingMessageId.value);
const { pinToBottom } = useAutoScroll(messageContainerRef, shouldAutoScroll);

const compactMarkersList = computed(() => compactMarkers.value);

useMessageHandler({
  messageContainerRef,
  chatInputRef,
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

// The compaction entry id awaiting rewind confirmation; non-null shows the shared confirm dialog. Both
// the boundary card and the rewind picker route a compaction selection here, so the confirm + fork
// post live in one place.
const pendingCompactionRewindId = ref<string | null>(null);

function handleCompactionRewind(entryId: string) {
  pendingCompactionRewindId.value = entryId;
}

function handleRewindBrowserSelect(item: RewindHistoryItem) {
  // A compaction anchor never opens the 4-option file-rewind modal (conversation-only); it closes the
  // picker and opens the shared compaction confirm. A normal prompt anchor keeps the existing flow.
  if (item.kind === "compaction") {
    uiStore.closeRewindBrowser();
    handleCompactionRewind(item.messageId);
    return;
  }
  uiStore.selectRewindItem(item);
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
    !showSettingsPanel.value &&
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
  if (btwStore.aside?.isStreaming) {
    postMessage({ type: "cancelBtw", btwId: btwStore.aside.id });
  }
  const btwId = `btw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  btwStore.addAside(btwId, btwMatch[1]!);
  postMessage({ type: "sendBtw", btwId, question: btwMatch[1]! });
  return true;
}

function tryInterceptUsage(content: string | UserContentBlock[]): boolean {
  if (typeof content !== "string") return false;
  if (content.trim() !== "/usage") return false;
  subscriptionUsageStore.openOverlay();
  postMessage({ type: "requestSubscriptionUsage" });
  return true;
}

function handleSendMessage(content: string | UserContentBlock[], includeIdeContext: boolean) {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
      openRewindFlow();
      return;
    }
    if (trimmed === "/clear") {
      postMessage({ type: "clearSession" });
      return;
    }
    if (trimmed === "/context") {
      contextUsageStore.openOverlay();
      postMessage({ type: "requestContextUsage" });
      return;
    }
  }

  if (tryInterceptUsage(content)) return;
  if (tryDispatchBtw(content)) return;

  postMessage({ type: "sendMessage", content, includeIdeContext });
  uiStore.setProcessing(true);
}

function handleQueueMessage(content: string | UserContentBlock[]) {
  if (tryInterceptUsage(content)) return;
  if (tryDispatchBtw(content)) return;
  postMessage({ type: "queueMessage", content });
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

function handleSessionSelect(sessionId: string) {
  const session = storedSessions.value.find((s) => s.id === sessionId);
  if (!session) return;

  const sessionName = session.customTitle || session.aiTitle || session.preview || null;
  streamingStore.$reset();
  teamStore.$reset();
  sessionStore.clearSessionData();
  sessionStore.setResumedSession(sessionId);
  sessionStore.setSelectedSession(sessionId, sessionName);
  postMessage({ type: "resumeSession", sessionId });
  setState({ ...getState(), sessionId, sessionName });
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

function handleSessionLoadMore() {
  if (!hasMoreSessions.value || loadingMoreSessions.value) return;
  sessionStore.setLoadingMoreSessions(true);
  postMessage({
    type: "requestMoreSessions",
    offset: nextSessionsOffset.value,
    selectedSessionId: selectedSessionId.value ?? undefined,
  });
}

function handleSessionSearch(query: string, offset: number = 0) {
  if (query.trim()) {
    if (offset > 0) {
      sessionStore.setLoadingMoreSessions(true);
    }
    postMessage({ type: "searchSessions", query, offset, selectedSessionId: selectedSessionId.value ?? undefined });
  } else {
    sessionStore.setLoadingMoreSessions(true);
    postMessage({ type: "requestMoreSessions", offset: 0, selectedSessionId: selectedSessionId.value ?? undefined });
  }
}

function handleSessionPickerOpen() {
  if (selectedSessionId.value) {
    postMessage({ type: "requestMoreSessions", offset: 0, selectedSessionId: selectedSessionId.value });
  }
}

function handleMessageScroll(event: Event) {
  const container = event.target as HTMLElement;
  if (!container) return;

  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  uiStore.setIsAtBottom(scrollBottom < 20);
}

function scrollToBottom() {
  pinToBottom();
}

function handleSetActiveModel(model: string) {
  settingsStore.setModelState(model, defaultModel.value);
  postMessage({ type: "setActiveModel", model });
}

function handleSetDefaultModel(model: string) {
  settingsStore.setModelState(activeModel.value, model);
  postMessage({ type: "setDefaultModel", model });
}

function handleSetPanelThinkingDisabled(disabled: boolean) {
  postMessage({ type: "setPanelThinkingDisabled", disabled });
}

function handleSetPanelEffort(effort: EffortLevel | null, model: string) {
  postMessage({ type: "setPanelEffort", effort, model });
}

function handleSetPanelMaxThinkingTokens(tokens: number | null, model: string) {
  postMessage({ type: "setPanelMaxThinkingTokens", tokens, model });
}

function handleSetDefaultThinkingDisabled(disabled: boolean) {
  postMessage({ type: "setDefaultThinkingDisabled", disabled });
}

function handleSetDefaultEffort(effort: EffortLevel | null, model: string) {
  postMessage({ type: "setDefaultEffort", effort, model });
}

function handleSetDefaultMaxThinkingTokens(tokens: number | null) {
  postMessage({ type: "setDefaultMaxThinkingTokens", tokens });
}

function handleSetBudgetLimit(budgetUsd: number | null) {
  settingsStore.setBudgetLimit(budgetUsd);
  postMessage({ type: "setBudgetLimit", budgetUsd });
}

function handleSetTaskBudget(budget: number | null) {
  settingsStore.setTaskBudget(budget);
  postMessage({ type: "setTaskBudget", budget });
}

function handleSetAutoCompact(config: AutoCompactConfig) {
  settingsStore.updateAutoCompactConfig(config);
  postMessage({ type: "setAutoCompact", config });
}

function handleSetPermissionMode(mode: PermissionMode) {
  postMessage({ type: "setPermissionMode", mode });
  settingsStore.setPermissionMode(mode);
}

function handleSetDefaultPermissionMode(mode: PermissionMode) {
  postMessage({ type: "setDefaultPermissionMode", mode });
  settingsStore.setDefaultPermissionMode(mode);
}

function handleSetWorktreeBaseRef(baseRef: 'fresh' | 'head') {
  postMessage({ type: "setWorktreeBaseRef", baseRef });
  settingsStore.setWorktreeBaseRef(baseRef);
}

function handleSetDefaultDangerouslySkipPermissions(enabled: boolean) {
  postMessage({ type: "setDefaultDangerouslySkipPermissions", enabled });
  settingsStore.setDefaultDangerouslySkipPermissions(enabled);
}

function handleSetIdeContextEnabled(enabled: boolean) {
  postMessage({ type: "setIdeContextEnabled", enabled });
  settingsStore.setIdeContextEnabledDefault(enabled);
  uiStore.setIdeContextDefault(enabled);
}

function handleOpenVSCodeSettings() {
  postMessage({ type: "openSettings" });
}

function handleInvokeSignIn() {
  postMessage({ type: "invokeSignIn" });
}

function handleSetVoiceProvider(provider: VoiceProvider) {
  postMessage({ type: "setVoiceProvider", provider });
}

function handleSetVoiceApiKey(provider: VoiceProvider, apiKey: string) {
  postMessage({ type: "setVoiceApiKey", provider, apiKey });
}

function handleDeleteVoiceApiKey(provider: VoiceProvider) {
  postMessage({ type: "deleteVoiceApiKey", provider });
}

function handleSetVoiceLanguage(language: string) {
  postMessage({ type: "setVoiceLanguage", language });
}

function handleSetVoiceMode(mode: VoiceMode) {
  postMessage({ type: "setVoiceMode", mode });
}

function handleSetExploreApiKey(apiKey: string) {
  postMessage({ type: "setExploreApiKey", apiKey });
}

function handleDeleteExploreApiKey() {
  postMessage({ type: "deleteExploreApiKey" });
}

function handleSetExploreProvider(provider: string) {
  postMessage({ type: "setExploreProvider", provider });
}

function handleSetExploreModel(model: string) {
  postMessage({ type: "setExploreModel", model });
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
  postMessage({ type: "openBrowser", url: "about:blank" });
}

function handleBindPlan() {
  // A fresh panel always has a runtime session id, so the extension's id guard can't tell "not started
  // yet" apart from a real session. An empty conversation is the reliable signal there's nothing to bind
  // a plan to — match view-plan's informational behavior with a toast instead of opening the picker.
  if (messages.value.length === 0) {
    toast.info(t("toast.noSessionToBindPlan"));
    return;
  }
  postMessage({ type: "bindPlanToSession" });
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
    postMessage({
      type: "rewindToMessage",
      userMessageId: selectedRewindItem.value.messageId,
      option,
      promptContent: selectedRewindItem.value.content,
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
  const permission = permissionStore.pendingPermissions[toolUseId];

  if (options?.acceptAll && !permission?.parentToolUseId && settingsStore.currentSettings.permissionMode !== "plan") {
    handleSetPermissionMode("acceptEdits");
  }

  // JSON round-trip to strip Vue reactive proxies before postMessage
  const updatedPermissions = options?.updatedPermissions ? JSON.parse(JSON.stringify(options.updatedPermissions)) : undefined;

  postMessage({
    type: "approveEdit",
    toolUseId,
    approved,
    customMessage: options?.customMessage,
    acceptAll: options?.acceptAll,
    parentToolUseId: permission?.parentToolUseId ?? undefined,
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

function handleOpenMemoryPanel() {
  uiStore.openMemoryPanel();
  postMessage({ type: "requestMemories" });
}

function handleCreateMemory(payload: { tier: MemoryTier; kind: 'fact' | 'preference' | 'episode'; content: string; requestId: string }) {
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
  postMessage({ type: "requestMoreObservations", cursor: memoryStore.observationCursor ?? undefined });
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
    clearContext: options.clearContext,
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
    streamingStore.updateToolStatus(toolUseId, "denied", { feedback: options?.customMessage });
  }

  if (options?.approvalMode === "acceptEdits" && settingsStore.currentSettings.permissionMode !== "plan") {
    handleSetPermissionMode("acceptEdits");
  }

  postMessage({
    type: "approveSkill",
    toolUseId,
    approved,
    approvalMode: options?.approvalMode,
    customMessage: options?.customMessage,
  });
  permissionStore.clearPendingSkillApproval();
}

const rewindMessagePreview = computed(() => {
  return selectedRewindItem.value?.content.slice(0, 100) || "";
});

const sessionHistoryOpen = ref(false);
const sessionPickerRef = ref<InstanceType<typeof SessionPicker> | null>(null);

function handleSessionHistorySelect(sessionId: string) {
  handleSessionSelect(sessionId);
  sessionHistoryOpen.value = false;
}

function handleSessionPopoverEscape(event: KeyboardEvent) {
  if (sessionPickerRef.value?.isInEditMode) {
    event.preventDefault();
  }
}


</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 bg-background text-foreground">
    <!-- Header bar with account info and controls -->
    <div class="px-3 py-1.5 text-xs border-b border-border/50 flex items-center gap-2 bg-card">
      <Popover v-if="accountInfo?.subscriptionType">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-auto px-1.5 py-0.5 rounded bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary">
            {{ accountInfo.subscriptionType }}
          </Button>
        </PopoverTrigger>
        <PopoverContent v-if="accountInfo.email" side="right" :side-offset="8" class="w-auto p-2 text-xs">
          {{ accountInfo.email }}
        </PopoverContent>
      </Popover>

      <div class="flex-1"></div>

      <!-- Prompt Navigator Chip -->
      <PromptNavigatorChip />

      <!-- Memory Consolidation -->
      <ConsolidationIndicator @click="handleOpenConsolidation" />

      <!-- Btw Aside Indicator -->
      <Button
        v-if="btwStore.hasAside"
        variant="ghost"
        size="icon-sm"
        class="relative text-muted-foreground hover:bg-muted hover:text-foreground"
        title="View aside"
        @click="btwStore.openOverlay()"
      >
        <IconMessageSquare :size="16" />
        <span
          v-if="btwStore.aside?.isStreaming"
          class="absolute inset-0 m-auto h-7 w-7 rounded-full border-2 border-transparent border-t-primary animate-spin pointer-events-none"
        />
      </Button>

      <!-- Open Browser Button -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Open Browser"
        @click="handleOpenBrowser"
      >
        <IconGlobe :size="16" />
      </Button>

      <!-- Bind Plan Button -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:bg-muted hover:text-foreground"
        :title="t('stats.bindPlan')"
        @click="handleBindPlan"
      >
        <IconLink :size="16" />
      </Button>

      <!-- View Plan Button -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:bg-muted hover:text-foreground"
        :title="t('stats.openPlan')"
        @click="handleOpenPlan"
      >
        <IconFileText :size="16" />
      </Button>

      <!-- Memory Button -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Memory"
        @click="handleOpenMemoryPanel"
      >
        <IconBrain :size="16" />
      </Button>

      <!-- MCP Status Indicator -->
      <McpStatusIndicator :servers="mcpServers" :disabled="isProcessing" @click="handleOpenMcpPanel" />

      <!-- Tools Status Indicator -->
      <ToolsStatusIndicator :snapshot="toolsSnapshot" :disabled="isProcessing" @click="handleOpenToolsPanel" />

      <!-- Session History Popover -->
      <Popover v-model:open="sessionHistoryOpen">
        <PopoverTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Session History"
          >
            <IconClock :size="16" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          class="w-[60vw] p-0"
          @escape-key-down="handleSessionPopoverEscape"
        >
          <SessionPicker
            ref="sessionPickerRef"
            :sessions="storedSessions"
            :selected-session-id="selectedSessionId"
            :selected-session-name="selectedSessionDisplayName"
            :has-more="hasMoreSessions"
            :loading="loadingMoreSessions"
            @select="handleSessionHistorySelect"
            @rename="handleSessionRename"
            @delete="handleSessionDelete"
            @tag="handleSessionTag"
            @load-more="handleSessionLoadMore"
            @search="handleSessionSearch"
            @open="handleSessionPickerOpen"
            @close="sessionHistoryOpen = false"
          />
        </PopoverContent>
      </Popover>

      <!-- Settings button -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-primary hover:bg-muted hover:text-primary"
        title="Settings"
        @click="uiStore.openSettingsPanel()"
      >
        <IconGear :size="18" />
      </Button>
    </div>

    <!-- Budget Warning Banner -->
    <BudgetWarning
      v-if="budgetWarning"
      :current-spend="budgetWarning.currentSpend"
      :limit="budgetWarning.limit"
      :exceeded="budgetWarning.exceeded"
      @dismiss="handleDismissBudgetWarning"
    />

    <!-- Context Warning Banner -->
    <ContextWarningBanner
      v-if="contextWarning"
      :level="contextWarning.level"
      :auto-compact-triggered="contextWarning.autoCompactTriggered"
      @dismiss="handleDismissContextWarning"
    />

    <!-- Auth Failure Banner -->
    <AuthFailureBanner
      v-if="authFailureMessage"
      :message="authFailureMessage"
      @sign-in="handleInvokeSignIn"
      @dismiss="uiStore.dismissAuthFailure"
    />

    <!-- Subagents Indicator (running and recently completed) -->
    <SubagentIndicator :subagents="subagents" @expand="subagentStore.expandSubagent" />

    <!-- Message area wrapper (relative positioning for scroll-to-bottom button) -->
    <div class="relative flex-1 min-h-0">
      <!-- Toast notifications (positioned in top-right of chat area) -->
      <Toaster position="top-right" :duration="4000" />

      <div ref="messageContainerRef" class="h-full overflow-y-auto message-container" @scroll="handleMessageScroll">
        <VirtualizedMessageList
          ref="messageListRef"
          :messages="messages"
          :streaming-message-id="streamingMessageId"
          :compact-markers="compactMarkersList"
          :checkpoint-messages="checkpointMessages"
          :subagents="subagents"
          @rewind="handleBubbleRewind"
          @rewind-to-compaction="handleCompactionRewind"
          @expand-subagent="subagentStore.expandSubagent"
          @expand-tool="streamingStore.expandTool"
          @expand-diff="diffStore.expandDiff"
          @view-context="handleViewContext"
        />
      </div>

      <!-- Scroll to bottom button (appears when scrolled up from bottom) -->
      <Transition name="fade">
        <Button
          v-if="!isAtBottom"
          variant="default"
          size="icon"
          class="absolute bottom-4 right-8 rounded-full bg-primary hover:bg-primary/90 shadow-lg shadow-primary/50 z-20"
          title="Scroll to bottom"
          @click="scrollToBottom"
        >
          <IconChevronDown :size="16" />
        </Button>
      </Transition>
    </div>

    <!-- Permission Prompt (queue - shows one at a time) -->
    <PermissionPrompt
      v-if="currentPermission"
      :visible="true"
      :tool-use-id="currentPermission.toolUseId"
      :tool-name="currentPermission.toolName"
      :file-path="currentPermission.filePath"
      :original-content="currentPermission.originalContent"
      :proposed-content="currentPermission.proposedContent"
      :command="currentPermission.command"
      :agent-description="currentPermission.agentDescription"
      :suggestions="currentPermission.suggestions"
      :blocked-path="currentPermission.blockedPath"
      :decision-reason="currentPermission.decisionReason"
      :queue-position="1"
      :queue-total="pendingPermissionCount"
      @approve="(approved, options) => handlePermissionApproval(currentPermission.toolUseId, approved, options)"
    />

    <TeamPermissionPrompt />

    <!-- Persistent Task List Panel (always visible when tasks exist) -->
    <div v-if="tasks.length > 0" class="px-3 py-2 border-t border-border/30 bg-card">
      <TaskListCard :tasks="tasks" :is-collapsed="tasksPanelCollapsed" @update:is-collapsed="uiStore.setTasksPanelCollapsed" />
    </div>

    <!-- Question Prompt for AskUserQuestion tool -->
    <QuestionPrompt v-if="pendingQuestion" :visible="true" @submit="handleQuestionSubmit" @cancel="handleQuestionCancel" />

    <!-- Webview-bridged dialogs for pi-extension ctx.ui.* (US-026) -->
    <ExtensionUiDialog />

    <!-- Skill Approval Prompt for Skill tool -->
    <SkillApprovalPrompt
      v-if="pendingSkillApproval"
      :visible="true"
      :skill-name="pendingSkillApproval.skillName"
      :skill-description="pendingSkillApproval.skillDescription"
      @approve="handleSkillApprove"
    />

    <!-- Elicitation Prompt for MCP server input requests -->
    <ElicitationPrompt />

    <!-- Status Bar with witty phrases (above input) -->
    <StatusBar
      :is-processing="isProcessing"
      :current-tool-name="currentRunningTool ?? undefined"
      :status-override="contextWarning?.autoCompactTriggered ? t('context.autoCompacting') : undefined"
      :active-hooks="uiStore.activeHooks"
    />

    <SessionStats :stats="sessionStats" @open-log="handleOpenSessionLog" @open-context-usage="handleOpenContextUsage">
      <TeamIndicator />
      <CompassIndicator />
      <BackgroundTasksIndicator @click="handleOpenBackgroundTasks" />
    </SessionStats>

    <ChatInput
      ref="chatInputRef"
      :is-processing="isProcessing"
      :permission-mode="currentSettings.permissionMode"
      :dangerously-skip-permissions="currentSettings.dangerouslySkipPermissions"
      :settings-open="showSettingsPanel"
      @send="handleSendMessage"
      @queue="handleQueueMessage"
      @cancel="handleCancel"
      @change-mode="handleModeChange"
      @toggle-dangerously-skip-permissions="handleToggleDangerouslySkipPermissions"
    />

    <!-- Settings Panel (overlay) -->
    <SettingsPanel
      :visible="showSettingsPanel"
      :settings="currentSettings"
      :available-models="availableModels"
      :active-model="activeModel"
      :default-model="defaultModel"
      :panel-thinking="panelThinking"
      :panel-thinking-model="panelThinkingModel"
      :default-thinking="defaultThinking"
      :default-thinking-model="defaultThinkingModel"
      :voice-config="voiceConfig"
      :voice-has-api-key="voiceHasApiKey"
      :explore-has-api-key="exploreHasApiKey"
      :explore-provider="exploreProvider"
      :explore-model="exploreModel"
      @close="uiStore.closeSettingsPanel()"
      @set-active-model="handleSetActiveModel"
      @set-default-model="handleSetDefaultModel"
      @set-panel-thinking-disabled="handleSetPanelThinkingDisabled"
      @set-panel-effort="handleSetPanelEffort"
      @set-panel-max-thinking-tokens="handleSetPanelMaxThinkingTokens"
      @set-default-thinking-disabled="handleSetDefaultThinkingDisabled"
      @set-default-effort="handleSetDefaultEffort"
      @set-default-max-thinking-tokens="handleSetDefaultMaxThinkingTokens"
      @set-budget-limit="handleSetBudgetLimit"
      @set-task-budget="handleSetTaskBudget"
      @set-auto-compact="handleSetAutoCompact"
      @set-default-permission-mode="handleSetDefaultPermissionMode"
      @set-default-dangerously-skip-permissions="handleSetDefaultDangerouslySkipPermissions"
      @set-ide-context-enabled="handleSetIdeContextEnabled"
      @set-worktree-base-ref="handleSetWorktreeBaseRef"
      @open-v-s-code-settings="handleOpenVSCodeSettings"
      @set-voice-provider="handleSetVoiceProvider"
      @set-voice-api-key="handleSetVoiceApiKey"
      @delete-voice-api-key="handleDeleteVoiceApiKey"
      @set-voice-language="handleSetVoiceLanguage"
      @set-voice-mode="handleSetVoiceMode"
      @set-explore-api-key="handleSetExploreApiKey"
      @delete-explore-api-key="handleDeleteExploreApiKey"
      @set-explore-provider="handleSetExploreProvider"
      @set-explore-model="handleSetExploreModel"
    />

    <!-- MCP Status Panel (modal) -->
    <McpStatusPanel
      :visible="showMcpPanel"
      :servers="mcpServers"
      :mcp-enabled="mcpEnabled"
      @close="uiStore.closeMcpPanel()"
      @toggle="handleToggleMcpServer"
      @toggle-enabled="handleSetMcpEnabled"
      @reconnect="handleReconnectMcpServer"
      @authenticate="handleAuthenticateMcpServer"
      @reauthenticate="handleReauthenticateMcpServer"
      @sign-out="handleSignOutMcpServer"
      @trust-project="postMessage({ type: 'setProjectTrusted' })"
    />

    <!-- Memory Panel (full-screen overlay) -->
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

    <!-- Tools Status Panel (modal) -->
    <ToolsStatusPanel
      :visible="showToolsPanel"
      :snapshot="toolsSnapshot"
      @close="uiStore.closeToolsPanel()"
      @toggle="handleToggleTool"
      @toggle-group="handleToggleToolGroup"
      @trust-project="postMessage({ type: 'setProjectTrusted' })"
    />

    <!-- Rewind Type Modal (pick rewind type first) -->
    <RewindConfirmModal
      :visible="showRewindTypeModal"
      :can-fork="rewindCanFork"
      :message-preview="rewindMessagePreview"
      :files-affected="selectedRewindItem?.filesAffected"
      :files="selectedRewindItem?.files"
      :lines-changed="selectedRewindItem?.linesChanged"
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
    <RewindBrowser
      v-if="showRewindBrowser"
      :is-open="showRewindBrowser"
      :prompts="rewindHistoryItems"
      :is-loading="rewindHistoryLoading"
      @select="handleRewindBrowserSelect"
      @close="uiStore.closeRewindBrowser"
    />

    <!-- Compaction rewind confirmation (shared by the boundary card and the rewind picker) -->
    <CompactionRewindConfirm
      v-if="pendingCompactionRewindId"
      :open="pendingCompactionRewindId !== null"
      @confirm="confirmCompactionRewind"
      @cancel="cancelCompactionRewind"
    />

    <!-- Subagent Overlay (full-screen) -->
    <SubagentOverlay
      v-if="expandedSubagent"
      :subagent="expandedSubagent"
      :streaming="expandedSubagent ? subagentStore.getSubagentStreaming(expandedSubagent.id) : undefined"
      @close="subagentStore.collapseSubagent"
      @open-log="handleOpenAgentLog"
    />

    <!-- Tool Overlay (full-screen) — MCP tools and built-in tools use dedicated overlays -->
    <McpToolOverlay v-if="expandedTool && expandedTool.name.startsWith('mcp__')" :tool="expandedTool" @close="streamingStore.collapseTool" />
    <ToolOverlay v-else-if="expandedTool" :tool="expandedTool" @close="streamingStore.collapseTool" />

    <!-- Diff Overlay (full-screen) -->
    <DiffOverlay v-if="expandedDiff" :diff="expandedDiff" @close="diffStore.collapseDiff" />

    <!-- Plan Approval Overlay (full-screen) -->
    <PlanApprovalOverlay
      v-if="pendingPlanApproval && isPlanOverlayVisible"
      :plan-content="pendingPlanApproval.planContent"
      @approve="handlePlanApprove"
      @feedback="handlePlanFeedback"
      @dismiss="handlePlanDismiss"
    />

    <!-- Plan View Overlay (read-only, full-screen) -->
    <PlanViewOverlay v-if="viewingPlan" :plan-content="viewingPlan" @close="planViewStore.closePlanView" />

    <!-- Context Injection Overlay -->
    <ContextInjectionOverlay v-if="contextInjectionStore.isOverlayOpen" @close="contextInjectionStore.closeOverlay()" />

    <!-- Context Usage Overlay -->
    <ContextUsageOverlay v-if="contextUsageStore.isOverlayOpen" @close="contextUsageStore.closeOverlay()" />
    <SubscriptionUsageOverlay v-if="subscriptionUsageStore.isOverlayOpen" @close="subscriptionUsageStore.closeOverlay()" />

    <ConsolidationOverlay v-if="consolidationStore.isOverlayOpen" @close="consolidationStore.closeOverlay()" />

    <!-- Background Tasks Overlay -->
    <BackgroundTasksOverlay v-if="backgroundTaskStore.isOverlayOpen" @close="backgroundTaskStore.closeOverlay()" />
    <TeamOverlay v-if="teamStore.isOverlayOpen" />
    <TeamAgentOverlay v-if="teamStore.isAgentOverlayOpen" />

    <CompassGraphOverlay v-if="compassStore.activePanel === 'graph'" />
    <CompassSearchOverlay v-if="compassStore.activePanel === 'search'" />
    <CompassValidationOverlay v-if="compassStore.activePanel === 'validate'" />

    <!-- Voice First-Run Modal (privacy disclosure) -->
    <VoiceFirstRunModal
      v-if="voiceFirstRunRequired"
      :reason="voiceFirstRunRequired"
      @accept="handleVoiceFirstRunAccept"
      @cancel="handleVoiceFirstRunCancel"
    />

    <!-- Voice Model Download Modal -->
    <VoiceModelDownloadModal
      v-if="voiceHasActiveDownload"
      :downloads="voiceModelDownload"
      @cancel="handleVoiceDownloadCancel"
      @open-license="handleVoiceLicenseOpen"
    />

    <!-- Voice Model Upgrade Modal -->
    <VoiceModelUpgradeModal
      v-if="voicePendingUpgrades.length > 0 && !voiceHasActiveDownload"
      :upgrades="voicePendingUpgrades"
      @accept="handleVoiceUpgradeAccept"
      @dismiss="handleVoiceUpgradeDismiss"
      @open-license="handleVoiceLicenseOpen"
    />

    <!-- Prompt Navigator Overlay (always mounted; Dialog manages enter/exit) -->
    <PromptNavigator @edit-and-resend="handleEditAndResend" @rewind="handleNavigatorRewind" />

    <!-- Btw Aside Overlay -->
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
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease-out;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
