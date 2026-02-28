<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { initLocaleMessaging } from "@/i18n";
import { onKeyStroke, useIntersectionObserver } from "@vueuse/core";
import { storeToRefs } from "pinia";
import MessageList from "./components/MessageList.vue";
import ChatInput from "./components/ChatInput.vue";
import SessionStats from "./components/SessionStats.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import { toast } from "vue-sonner";
import { Toaster } from "@/components/ui/sonner";
import McpStatusIndicator from "./components/McpStatusIndicator.vue";
import McpStatusPanel from "./components/McpStatusPanel.vue";
import PluginStatusIndicator from "./components/PluginStatusIndicator.vue";
import PluginStatusPanel from "./components/PluginStatusPanel.vue";
import RemoteControlIndicator from "./components/RemoteControlIndicator.vue";
import SubagentIndicator from "./components/SubagentIndicator.vue";
import SubagentOverlay from "./components/SubagentOverlay.vue";
import DiffOverlay from "./components/DiffOverlay.vue";
import McpToolOverlay from "./components/McpToolOverlay.vue";
import ToolOverlay from "./components/ToolOverlay.vue";
import StatusBar from "./components/StatusBar.vue";
import BudgetWarning from "./components/BudgetWarning.vue";
import ContextWarningBanner from "./components/ContextWarningBanner.vue";
import RewindBrowser from "./components/RewindBrowser.vue";
import RewindConfirmModal from "./components/RewindConfirmModal.vue";
import SessionPicker from "./components/SessionPicker.vue";
import PermissionPrompt from "./components/PermissionPrompt.vue";
import QuestionPrompt from "./components/QuestionPrompt.vue";
import PlanApprovalOverlay from "./components/PlanApprovalOverlay.vue";
import PlanViewOverlay from "./components/PlanViewOverlay.vue";
import HaikuObserverOverlay from "./components/HaikuObserverOverlay.vue";
import ContextInjectionOverlay from "./components/ContextInjectionOverlay.vue";
import ContextUsageOverlay from "./components/ContextUsageOverlay.vue";
import SkillApprovalPrompt from "./components/SkillApprovalPrompt.vue";
import MemoryPanel from "./components/MemoryPanel.vue";
import TaskListCard from "./components/TaskListCard.vue";
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
import { useHaikuObserverStore } from "./stores/useHaikuObserverStore";
import { useContextInjectionStore } from "./stores/useContextInjectionStore";
import { useContextUsageStore } from "./stores/useContextUsageStore";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IconGear, IconChevronDown, IconFileText, IconLink, IconBrain, IconSparkles } from "@/components/icons";
import type { PermissionMode, ContextStrategy, ProviderProfile, ReasoningEffort } from "@shared/types/settings";
import type { VoiceProvider } from "@shared/types/voice";
import type { MemoryTier } from "@shared/types/memory";
import type { RewindOption } from "@shared/types/session";
import type { UserContentBlock } from "@shared/types/content";
import type { PermissionUpdate } from "@shared/types/permissions";

const { postMessage, setState, getState } = useVSCode();
const { t } = useI18n();

initLocaleMessaging(postMessage);

const uiStore = useUIStore();
const {
  isProcessing,
  isAtBottom,
  showSettingsPanel,
  showMcpPanel,
  showPluginPanel,
  showMemoryPanel,
  currentRunningTool,
  showRewindTypeModal,
  showRewindBrowser,
  rewindHistoryItems,
  rewindHistoryLoading,
  selectedRewindItem,
  tasksPanelCollapsed,
} = storeToRefs(uiStore);

const settingsStore = useSettingsStore();
const {
  currentSettings,
  availableModels,
  accountInfo,
  mcpServers,
  plugins,
  budgetWarning,
  contextWarning,
  providerProfiles,
  activeProviderProfile,
  defaultProviderProfile,
  activeModel,
  defaultModel,
  activeBetas,
  activeContextStrategy,
  defaultContextStrategy,
  distillTokenBudget,
  voiceConfig,
  voiceHasApiKey,
} = storeToRefs(settingsStore);

const sessionStore = useSessionStore();
const {
  selectedSessionId,
  selectedSessionDisplayName,
  currentResumedSessionId,
  storedSessions,
  hasMoreSessions,
  nextSessionsOffset,
  loadingMoreSessions,
  hasMoreHistory,
  nextHistoryOffset,
  loadingMoreHistory,
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
const { sessionMemories, projectMemories, globalMemories, notes, observations, searchResults } = storeToRefs(memoryStore);

const planViewStore = usePlanViewStore();
const { viewingPlan } = storeToRefs(planViewStore);

const haikuObserverStore = useHaikuObserverStore();
const contextInjectionStore = useContextInjectionStore();
const contextUsageStore = useContextUsageStore();

const isDistillMode = computed(() => activeContextStrategy.value === 'distill');

const messageContainerRef = ref<HTMLElement | null>(null);
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);
const historySentinelRef = ref<HTMLElement | null>(null);

const shouldAutoScroll = computed(() => isProcessing.value || !!streamingMessageId.value);
useAutoScroll(messageContainerRef, shouldAutoScroll);

const compactMarkersList = computed(() => compactMarkers.value);

useIntersectionObserver(
  historySentinelRef,
  ([entry]) => {
    if (!entry) return;
    if (entry.isIntersecting && hasMoreHistory.value && !loadingMoreHistory.value && currentResumedSessionId.value) {
      loadMoreHistory();
    }
  },
  { root: messageContainerRef, threshold: 0 },
);

useMessageHandler({
  messageContainerRef,
  chatInputRef,
});

function openRewindFlow() {
  uiStore.openRewindBrowser();
  postMessage({ type: "requestRewindHistory" });
}

useDoubleKeyStroke("Escape", () => {
  if (!showRewindTypeModal.value && !showRewindBrowser.value && !showSettingsPanel.value && !showMcpPanel.value && !showPluginPanel.value && !showMemoryPanel.value) {
    openRewindFlow();
  }
});

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

  postMessage({ type: "sendMessage", content, includeIdeContext });
}

function handleQueueMessage(content: string | UserContentBlock[]) {
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

  const sessionIsDistill = session.isDistill === true;
  if (sessionIsDistill !== isDistillMode.value) {
    const mode = sessionIsDistill ? "Distill" : "Normal";
    toast.warning(t("session.cannotLoadCrossMode", { mode }));
    return;
  }

  const sessionName = session.customTitle || session.preview || null;
  streamingStore.$reset();
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

function loadMoreHistory() {
  if (!hasMoreHistory.value || loadingMoreHistory.value || !currentResumedSessionId.value) {
    return;
  }

  sessionStore.setLoadingMoreHistory(true);
  postMessage({
    type: "requestMoreHistory",
    sessionId: currentResumedSessionId.value,
    offset: nextHistoryOffset.value,
  });
}

function handleMessageScroll(event: Event) {
  const container = event.target as HTMLElement;
  if (!container) return;

  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  uiStore.setIsAtBottom(scrollBottom < 20);
}

function scrollToBottom() {
  const container = messageContainerRef.value;
  if (container) {
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }
}

function handleSetActiveModel(model: string) {
  settingsStore.setModelState(model, defaultModel.value);
  postMessage({ type: "setActiveModel", model });
}

function handleSetDefaultModel(model: string) {
  settingsStore.setModelState(activeModel.value, model);
  postMessage({ type: "setDefaultModel", model });
}

function handleSetMaxThinkingTokens(tokens: number | null) {
  settingsStore.setMaxThinkingTokens(tokens);
  postMessage({ type: "setMaxThinkingTokens", tokens });
}

function handleSetThinkingDisabled(disabled: boolean) {
  settingsStore.setThinkingDisabled(disabled);
  postMessage({ type: "setThinkingDisabled", disabled });
}

function handleSetEffort(effort: ReasoningEffort | null) {
  settingsStore.setEffort(effort);
  postMessage({ type: "setEffort", effort });
}

function handleSetBudgetLimit(budgetUsd: number | null) {
  settingsStore.setBudgetLimit(budgetUsd);
  postMessage({ type: "setBudgetLimit", budgetUsd });
}

function handleToggleBeta(beta: string, enabled: boolean) {
  const current = activeBetas.value;
  const updated = enabled
    ? (current.includes(beta) ? current : [...current, beta])
    : current.filter(b => b !== beta);
  settingsStore.setBetaState(updated);
  postMessage({ type: "toggleBeta", beta, enabled });
}

function handleSetPermissionMode(mode: PermissionMode) {
  postMessage({ type: "setPermissionMode", mode });
  settingsStore.setPermissionMode(mode);
}

function handleSetDefaultPermissionMode(mode: PermissionMode) {
  postMessage({ type: "setDefaultPermissionMode", mode });
  settingsStore.setDefaultPermissionMode(mode);
}

function handleSetActiveContextStrategy(strategy: ContextStrategy) {
  settingsStore.setContextStrategyState(strategy, defaultContextStrategy.value, distillTokenBudget.value);
  postMessage({ type: "setActiveContextStrategy", strategy });
}

function handleSetDefaultContextStrategy(strategy: ContextStrategy) {
  settingsStore.setContextStrategyState(activeContextStrategy.value, strategy, distillTokenBudget.value);
  postMessage({ type: "setDefaultContextStrategy", strategy });
}

function handleSetDistillTokenBudget(value: number) {
  settingsStore.setContextStrategyState(activeContextStrategy.value, defaultContextStrategy.value, value);
  postMessage({ type: "setDistillTokenBudget", value });
}

function handleOpenVSCodeSettings() {
  postMessage({ type: "openSettings" });
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

function handleCreateProfile(profile: ProviderProfile) {
  postMessage({ type: "createProviderProfile", profile });
}

function handleUpdateProfile(originalName: string, profile: ProviderProfile) {
  postMessage({ type: "updateProviderProfile", originalName, profile });
}

function handleDeleteProfile(profileName: string) {
  postMessage({ type: "deleteProviderProfile", profileName });
}

function handleSetActiveProfile(profileName: string | null) {
  postMessage({ type: "setActiveProviderProfile", profileName });
}

function handleSetDefaultProfile(profileName: string | null) {
  postMessage({ type: "setDefaultProviderProfile", profileName });
}

function handleOpenSessionLog() {
  postMessage({ type: "openSessionLog" });
}

function handleOpenPlan() {
  postMessage({ type: "openSessionPlan" });
}

function handleOpenContext() {
  haikuObserverStore.openOverlay();
  if (!haikuObserverStore.activitiesLoaded) {
    postMessage({ type: "requestHaikuActivity" });
  }
}

function handleOpenContextUsage() {
  contextUsageStore.openOverlay();
  postMessage({ type: "requestContextUsage" });
}

function handleViewContext(promptIndex: number) {
  contextInjectionStore.openOverlay(promptIndex);
  postMessage({ type: "requestContextInjection", promptIndex });
}

function handleBindPlan() {
  postMessage({ type: "bindPlanToSession" });
}

function handleOpenAgentLog(agentId: string) {
  postMessage({ type: "openAgentLog", agentId });
}

function handleRefreshMcpStatus() {
  postMessage({ type: "requestMcpStatus" });
}

function handleToggleMcpServer(serverName: string, enabled: boolean) {
  postMessage({ type: "toggleMcpServer", serverName, enabled });
}

function handleReconnectMcpServer(serverName: string) {
  postMessage({ type: "reconnectMcpServer", serverName });
}

function handleAuthenticateMcpServer(serverName: string) {
  postMessage({ type: "authenticateMcpServer", serverName });
}

function handleRefreshPluginStatus() {
  postMessage({ type: "requestPluginStatus" });
}

function handleTogglePlugin(pluginFullId: string, enabled: boolean) {
  postMessage({ type: "togglePlugin", pluginFullId, enabled });
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
  options?: { acceptAll?: boolean; customMessage?: string; updatedPermissions?: PermissionUpdate[] }
) {
  const permission = permissionStore.pendingPermissions[toolUseId];

  if (options?.acceptAll && !permission?.parentToolUseId && settingsStore.currentSettings.permissionMode !== "plan") {
    handleSetPermissionMode("acceptEdits");
  }

  // JSON round-trip to strip Vue reactive proxies before postMessage
  const updatedPermissions = options?.updatedPermissions
    ? JSON.parse(JSON.stringify(options.updatedPermissions))
    : undefined;

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

function handleQuestionSubmit(answers: Record<string, string>) {
  if (pendingQuestion.value) {
    postMessage({
      type: "answerQuestion",
      toolUseId: pendingQuestion.value.toolUseId,
      answers,
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

function handleCreateMemory(tier: MemoryTier, content: string) {
  postMessage({ type: "createMemory", tier, content });
}

function handleDeleteMemory(id: string) {
  postMessage({ type: "deleteMemory", id });
}

function handleSearchMemories(query: string) {
  postMessage({ type: "searchMemories", query: { query } });
}

function handlePinMemory(id: string) {
  postMessage({ type: "pinMemory", id });
}

function handleUnpinMemory(id: string) {
  postMessage({ type: "unpinMemory", id });
}

function handleDismissBudgetWarning() {
  settingsStore.dismissBudgetWarning();
}

function handleDismissContextWarning() {
  if (contextWarning.value?.autoCompactTriggered) {
    postMessage({ type: 'cancelAutoCompact' });
  }
  settingsStore.dismissContextWarning();
}

function handlePlanApprove(options: { approvalMode: "acceptEdits" | "manual"; clearContext?: boolean }) {
  if (!pendingPlanApproval.value) return;
  const { toolUseId, planContent } = pendingPlanApproval.value;
  streamingStore.updateToolStatus(toolUseId, "completed");
  permissionStore.storePlanApproval(toolUseId, options.approvalMode);
  postMessage({
    type: "approvePlan",
    toolUseId,
    approved: true,
    approvalMode: options.approvalMode,
    clearContext: options.clearContext,
    planContent: options.clearContext ? planContent : undefined,
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

onKeyStroke('Escape', (e) => {
  if (pendingPlanApproval.value && !isPlanOverlayVisible.value) {
    e.stopPropagation();
    e.preventDefault();
    handlePlanCancel();
  }
}, { target: document });

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
        <PopoverContent v-if="accountInfo.email" side="right" :side-offset="8" class="w-auto p-2 text-[11px]">
          {{ accountInfo.email }}
        </PopoverContent>
      </Popover>

      <div class="flex-1"></div>

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

      <!-- Distill Context Button -->
      <Button
        v-if="isDistillMode"
        variant="ghost"
        size="icon-sm"
        class="relative text-muted-foreground hover:bg-muted hover:text-foreground"
        :title="t('haikuObserver.title')"
        @click="handleOpenContext"
      >
        <span
          v-if="haikuObserverStore.isObservationStreaming"
          class="absolute inset-0 m-auto h-6 w-6 rounded-full border-2 border-transparent border-t-primary animate-spin"
        />
        <IconSparkles :size="16" />
      </Button>

      <!-- MCP Status Indicator -->
      <McpStatusIndicator :servers="mcpServers" :disabled="isProcessing" @click="uiStore.openMcpPanel()" />

      <!-- Plugin Status Indicator -->
      <PluginStatusIndicator :plugins="plugins" :disabled="isProcessing" @click="uiStore.openPluginPanel()" />

      <!-- Remote Control Indicator -->
      <RemoteControlIndicator />

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

    <!-- Subagents Indicator (running and recently completed) -->
    <SubagentIndicator :subagents="subagents" @expand="subagentStore.expandSubagent" />

    <!-- Session picker dropdown -->
    <SessionPicker
      :sessions="storedSessions"
      :selected-session-id="selectedSessionId"
      :selected-session-name="selectedSessionDisplayName"
      :has-more="hasMoreSessions"
      :loading="loadingMoreSessions"
      @select="handleSessionSelect"
      @rename="handleSessionRename"
      @delete="handleSessionDelete"
      @load-more="handleSessionLoadMore"
      @search="handleSessionSearch"
      @open="handleSessionPickerOpen"
    />

    <!-- Message area wrapper (relative positioning for scroll-to-bottom button) -->
    <div class="relative flex-1 min-h-0">
      <!-- Toast notifications (positioned in top-right of chat area) -->
      <Toaster position="top-right" :duration="4000" />

      <div ref="messageContainerRef" class="h-full overflow-y-auto message-container" @scroll="handleMessageScroll">
        <!-- Sentinel for infinite scroll (Intersection Observer target) -->
        <div v-if="hasMoreHistory || loadingMoreHistory" ref="historySentinelRef" class="h-4">
          <div v-if="loadingMoreHistory" class="text-center py-3 text-xs text-muted-foreground animate-pulse">Loading history...</div>
        </div>

        <MessageList
          :messages="messages"
          :streaming-message-id="streamingMessageId"
          :compact-markers="compactMarkersList"
          :checkpoint-messages="checkpointMessages"
          :subagents="subagents"
          @rewind="openRewindFlow"
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
          class="absolute bottom-4 right-8 rounded-full bg-primary hover:bg-primary/90 shadow-lg shadow-primary/50 z-10"
          title="Scroll to bottom"
          @click="scrollToBottom"
        >
          <IconChevronDown :size="16" />
        </Button>
      </Transition>
    </div>

    <!-- Persistent Task List Panel (always visible when tasks exist) -->
    <div v-if="tasks.length > 0" class="px-3 py-2 border-t border-border/30 bg-card">
      <TaskListCard :tasks="tasks" :is-collapsed="tasksPanelCollapsed" @update:is-collapsed="uiStore.setTasksPanelCollapsed" />
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

    <!-- Question Prompt for AskUserQuestion tool -->
    <QuestionPrompt v-if="pendingQuestion" :visible="true" @submit="handleQuestionSubmit" @cancel="handleQuestionCancel" />

    <!-- Skill Approval Prompt for Skill tool -->
    <SkillApprovalPrompt
      v-if="pendingSkillApproval"
      :visible="true"
      :skill-name="pendingSkillApproval.skillName"
      :skill-description="pendingSkillApproval.skillDescription"
      @approve="handleSkillApprove"
    />

    <!-- Status Bar with witty phrases (above input) -->
    <StatusBar
      :is-processing="isProcessing"
      :current-tool-name="currentRunningTool ?? undefined"
      :status-override="contextWarning?.autoCompactTriggered ? t('context.autoCompacting') : undefined"
    />

    <SessionStats :stats="sessionStats" @open-log="handleOpenSessionLog" @open-context-usage="handleOpenContextUsage" />

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
      :provider-profiles="providerProfiles"
      :active-provider-profile="activeProviderProfile"
      :default-provider-profile="defaultProviderProfile"
      :active-model="activeModel"
      :default-model="defaultModel"
      :active-betas="activeBetas"
      :active-context-strategy="activeContextStrategy"
      :default-context-strategy="defaultContextStrategy"
      :distill-token-budget="distillTokenBudget"
      :voice-config="voiceConfig"
      :voice-has-api-key="voiceHasApiKey"
      @close="uiStore.closeSettingsPanel()"
      @set-active-model="handleSetActiveModel"
      @set-default-model="handleSetDefaultModel"
      @set-max-thinking-tokens="handleSetMaxThinkingTokens"
      @set-thinking-disabled="handleSetThinkingDisabled"
      @set-effort="handleSetEffort"
      @set-budget-limit="handleSetBudgetLimit"
      @toggle-beta="handleToggleBeta"
      @set-default-permission-mode="handleSetDefaultPermissionMode"
      @set-active-context-strategy="handleSetActiveContextStrategy"
      @set-default-context-strategy="handleSetDefaultContextStrategy"
      @set-distill-token-budget="handleSetDistillTokenBudget"
      @open-v-s-code-settings="handleOpenVSCodeSettings"
      @create-profile="handleCreateProfile"
      @update-profile="handleUpdateProfile"
      @delete-profile="handleDeleteProfile"
      @set-active-profile="handleSetActiveProfile"
      @set-default-profile="handleSetDefaultProfile"
      @set-voice-provider="handleSetVoiceProvider"
      @set-voice-api-key="handleSetVoiceApiKey"
      @delete-voice-api-key="handleDeleteVoiceApiKey"
      @set-voice-language="handleSetVoiceLanguage"
    />

    <!-- MCP Status Panel (modal) -->
    <McpStatusPanel
      :visible="showMcpPanel"
      :servers="mcpServers"
      @close="uiStore.closeMcpPanel()"
      @refresh="handleRefreshMcpStatus"
      @toggle="handleToggleMcpServer"
      @reconnect="handleReconnectMcpServer"
      @authenticate="handleAuthenticateMcpServer"
    />

    <!-- Memory Panel (full-screen overlay) -->
    <MemoryPanel
      v-if="showMemoryPanel"
      :session-memories="sessionMemories"
      :project-memories="projectMemories"
      :global-memories="globalMemories"
      :notes="notes"
      :observations="observations"
      :search-results="searchResults"
      @close="uiStore.closeMemoryPanel()"
      @create="handleCreateMemory"
      @delete="handleDeleteMemory"
      @search="handleSearchMemories"
      @pin="handlePinMemory"
      @unpin="handleUnpinMemory"
    />

    <!-- Plugin Status Panel (modal) -->
    <PluginStatusPanel
      :visible="showPluginPanel"
      :plugins="plugins"
      @close="uiStore.closePluginPanel()"
      @refresh="handleRefreshPluginStatus"
      @toggle="handleTogglePlugin"
    />

    <!-- Rewind Type Modal (pick rewind type first) -->
    <RewindConfirmModal
      :visible="showRewindTypeModal"
      :message-preview="rewindMessagePreview"
      :files-affected="selectedRewindItem?.filesAffected"
      :lines-changed="selectedRewindItem?.linesChanged"
      @confirm="handleTypeSelected"
      @cancel="uiStore.cancelTypeSelection"
    />

    <!-- Rewind Browser (pick which message to rewind to) -->
    <RewindBrowser
      :is-open="showRewindBrowser"
      :prompts="rewindHistoryItems"
      :is-loading="rewindHistoryLoading"
      @select="uiStore.selectRewindItem"
      @close="uiStore.closeRewindBrowser"
    />

    <!-- Subagent Overlay (full-screen) -->
    <SubagentOverlay
      v-if="expandedSubagent"
      :subagent="expandedSubagent"
      :streaming="expandedSubagent ? subagentStore.getSubagentStreaming(expandedSubagent.id) : undefined"
      @close="subagentStore.collapseSubagent"
      @open-log="handleOpenAgentLog"
    />

    <!-- Tool Overlay (full-screen) — MCP tools use dedicated overlay, built-in tools use generic -->
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

    <!-- Haiku Observer Overlay -->
    <HaikuObserverOverlay
      v-if="haikuObserverStore.isOverlayOpen"
      @close="haikuObserverStore.closeOverlay()"
    />

    <!-- Context Injection Overlay -->
    <ContextInjectionOverlay
      v-if="contextInjectionStore.isOverlayOpen"
      @close="contextInjectionStore.closeOverlay()"
    />

    <!-- Context Usage Overlay -->
    <ContextUsageOverlay
      v-if="contextUsageStore.isOverlayOpen"
      @close="contextUsageStore.closeOverlay()"
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
