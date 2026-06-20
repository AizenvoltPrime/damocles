import { computed, type ComputedRef } from "vue";
import {
  useUIStore,
  usePermissionStore,
  useStreamingStore,
  useSubagentStore,
  useQuestionStore,
  useDiffStore,
} from "@/stores";
import { usePlanViewStore } from "@/stores/usePlanViewStore";
import { useContextInjectionStore } from "@/stores/useContextInjectionStore";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useBackgroundTaskStore } from "@/stores/useBackgroundTaskStore";
import { useWorkflowStore } from "@/stores/useWorkflowStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useCompassStore } from "@/stores/useCompassStore";
import { useBtwStore } from "@/stores/useBtwStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";

export function isForegroundOverlayOpen(): boolean {
  const uiStore = useUIStore();
  const permissionStore = usePermissionStore();
  const streamingStore = useStreamingStore();
  const subagentStore = useSubagentStore();
  const questionStore = useQuestionStore();
  const diffStore = useDiffStore();
  const planViewStore = usePlanViewStore();
  const contextInjectionStore = useContextInjectionStore();
  const contextUsageStore = useContextUsageStore();
  const backgroundTaskStore = useBackgroundTaskStore();
  const workflowStore = useWorkflowStore();
  const teamStore = useTeamStore();
  const compassStore = useCompassStore();
  const btwStore = useBtwStore();
  const voiceJarvisStore = useVoiceJarvisStore();

  if (uiStore.showRewindBrowser) return true;
  if (uiStore.showSettingsPanel) return true;
  if (uiStore.showMcpPanel) return true;
  if (uiStore.showToolsPanel) return true;
  if (uiStore.showMemoryPanel) return true;
  if (uiStore.showRewindTypeModal) return true;
  if (permissionStore.currentPermission) return true;
  if (permissionStore.pendingPlanApproval && permissionStore.isPlanOverlayVisible) return true;
  if (permissionStore.pendingSkillApproval) return true;
  if (questionStore.pendingQuestion) return true;
  if (subagentStore.expandedSubagent) return true;
  if (streamingStore.expandedTool) return true;
  if (diffStore.expandedDiff) return true;
  if (planViewStore.viewingPlan) return true;
  if (contextInjectionStore.isOverlayOpen) return true;
  if (contextUsageStore.isOverlayOpen) return true;
  if (backgroundTaskStore.isOverlayOpen) return true;
  if (workflowStore.isOverlayOpen) return true;
  if (teamStore.isOverlayOpen) return true;
  if (teamStore.isAgentOverlayOpen) return true;
  if (compassStore.activePanel !== null) return true;
  if (btwStore.isOverlayOpen) return true;
  if (voiceJarvisStore.firstRunRequired) return true;
  if (voiceJarvisStore.hasActiveDownload) return true;
  if (voiceJarvisStore.pendingUpgrades.length > 0) return true;
  return false;
}

export function useForegroundOverlayOpen(): ComputedRef<boolean> {
  return computed(() => isForegroundOverlayOpen());
}
