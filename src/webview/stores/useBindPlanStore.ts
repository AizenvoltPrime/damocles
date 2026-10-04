import { ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { useSessionStore } from './useSessionStore';
import { useSettingsStore } from './useSettingsStore';

export type PlanFileCandidate = Extract<ExtensionToWebviewMessage, { type: 'planFileCandidates' }>['files'][number];

export const useBindPlanStore = defineStore('bindPlan', () => {
  const isOpen = ref(false);
  const files = shallowRef<PlanFileCandidate[]>([]);
  const hasPlan = ref(false);
  /** False from open until core answers, so the overlay shows loading rather than "no plan files". */
  const loaded = ref(false);
  const listFailed = ref(false);

  function open(): void {
    isOpen.value = true;
    files.value = [];
    hasPlan.value = false;
    loaded.value = false;
    listFailed.value = false;
  }

  function close(): void {
    isOpen.value = false;
  }

  function setCandidates(next: PlanFileCandidate[], bound: boolean, failed = false): void {
    if (!isOpen.value) return;
    files.value = next;
    hasPlan.value = bound;
    loaded.value = true;
    listFailed.value = failed;
  }

  // A list belongs to the session and folder it was requested for.
  const sessionStore = useSessionStore();
  const settingsStore = useSettingsStore();
  watch([() => sessionStore.currentResumedSessionId, () => settingsStore.panelWorkspaceFolderKey], close);

  return { isOpen, files, hasPlan, loaded, listFailed, open, close, setCandidates };
});
