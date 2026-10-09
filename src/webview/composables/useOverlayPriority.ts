import { computed, type ComputedRef } from "vue";
import { useUIStore, usePermissionStore, useQuestionStore, useFormStore } from "@/stores";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { openOverlayCount } from "@/composables/useOverlayEscape";

/** Whether a foreground surface other than the prompt navigator is up, which the navigator's toggle must leave alone. */
export function isForegroundOverlayOpen(): boolean {
  // Every full overlay registers in the overlay stack, the navigator's own entry and the rewind confirmation included.
  const navigatorEntries = usePromptNavigatorStore().isOpen ? 1 : 0;
  if (openOverlayCount() > navigatorEntries) return true;

  // Foreground surfaces outside this page's stack: the prompts sit in the composer dock, and desktop renders the settings
  // modal in its own overlay page.
  const uiStore = useUIStore();
  const permissionStore = usePermissionStore();
  return uiStore.showSettingsModal
    || Boolean(permissionStore.currentPermission)
    || Boolean(permissionStore.pendingSkillApproval)
    || Boolean(useQuestionStore().pendingQuestion)
    || Boolean(useFormStore().pendingForm);
}

export function useForegroundOverlayOpen(): ComputedRef<boolean> {
  return computed(() => isForegroundOverlayOpen());
}
