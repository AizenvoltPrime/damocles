import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { PendingPermissionInfo } from '@shared/types/permissions';

interface PendingPlanApproval {
  toolUseId: string;
  planContent: string;
}

interface ApprovedPlanInfo {
  planContent: string;
  approvalMode: 'acceptEdits' | 'manual';
}

interface PendingSkillApproval {
  toolUseId: string;
  skillName: string;
  skillDescription?: string;
}

export const usePermissionStore = defineStore('permission', () => {
  const pendingPermissions = ref<Record<string, PendingPermissionInfo>>({});
  const pendingPlanApproval = ref<PendingPlanApproval | null>(null);
  const pendingSkillApproval = ref<PendingSkillApproval | null>(null);
  const approvedPlans = ref<Record<string, ApprovedPlanInfo>>({});

  const currentPermission = computed(() => {
    const entries = Object.values(pendingPermissions.value);
    if (entries.length === 0) return null;
    return entries[0];
  });

  const pendingCount = computed(() => Object.keys(pendingPermissions.value).length);

  function addPermission(
    toolUseId: string,
    info: Omit<PendingPermissionInfo, 'toolUseId'>
  ) {
    pendingPermissions.value = {
      ...pendingPermissions.value,
      [toolUseId]: { toolUseId, ...info },
    };
  }

  function removePermission(toolUseId: string) {
    const { [toolUseId]: _, ...rest } = pendingPermissions.value;
    pendingPermissions.value = rest;
  }

  function $reset() {
    pendingPermissions.value = {};
    pendingPlanApproval.value = null;
    pendingSkillApproval.value = null;
    approvedPlans.value = {};
  }

  function setPendingPlanApproval(info: PendingPlanApproval | null) {
    pendingPlanApproval.value = info;
  }

  function clearPendingPlanApproval() {
    pendingPlanApproval.value = null;
  }

  function storePlanApproval(toolUseId: string, approvalMode: 'acceptEdits' | 'manual') {
    if (!pendingPlanApproval.value || pendingPlanApproval.value.toolUseId !== toolUseId) {
      return;
    }
    approvedPlans.value = {
      ...approvedPlans.value,
      [toolUseId]: {
        planContent: pendingPlanApproval.value.planContent,
        approvalMode,
      },
    };
  }

  function getApprovedPlan(toolUseId: string): ApprovedPlanInfo | null {
    return approvedPlans.value[toolUseId] ?? null;
  }

  function setPendingSkillApproval(info: PendingSkillApproval | null) {
    pendingSkillApproval.value = info;
  }

  function clearPendingSkillApproval() {
    pendingSkillApproval.value = null;
  }

  return {
    pendingPermissions,
    currentPermission,
    pendingCount,
    addPermission,
    removePermission,
    pendingPlanApproval,
    setPendingPlanApproval,
    clearPendingPlanApproval,
    approvedPlans,
    storePlanApproval,
    getApprovedPlan,
    pendingSkillApproval,
    setPendingSkillApproval,
    clearPendingSkillApproval,
    $reset,
  };
});
