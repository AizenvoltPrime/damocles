import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { HostCapabilities } from '@shared/types/messages';

function onServer(capabilities: HostCapabilities): boolean {
  return capabilities.globalMemoryOnServer === true;
}

/** Every locale key whose text names the global memory scope, with its variant that names the server; both locales carry each variant. */
export const GLOBAL_SERVER_VARIANTS: ReadonlyMap<string, string> = new Map([
  ['memory.scope.global', 'memory.scope.globalServer'],
  ['memory.toast.saved.global', 'memory.toast.saved.globalServer'],
  ['memoryAudit.profile.global', 'memoryAudit.profile.globalServer'],
  ['memoryAudit.action.rescope_global', 'memoryAudit.action.rescope_globalServer'],
  ['memoryPanel.addPlaceholder.global', 'memoryPanel.addPlaceholder.globalServer'],
  ['memoryPanel.profileHint', 'memoryPanel.profileHintGlobalServer'],
  ['consolidation.stepper.profilesDone', 'consolidation.stepper.profilesDoneGlobalServer'],
  ['contextInjection.formula.storeSize', 'contextInjection.formula.storeSizeGlobalServer'],
]);

/** `key`, or its variant naming the server when the host keeps global memories there; a key with no variant is returned as is. */
export function memoryScopeKey(key: string, capabilities: HostCapabilities): string {
  return onServer(capabilities) ? GLOBAL_SERVER_VARIANTS.get(key) ?? key : key;
}

/** The saved toast's key for a memory of `tier`. */
export function memorySavedToastKey(tier: string, capabilities: HostCapabilities): string {
  return memoryScopeKey(`memory.toast.saved.${tier}`, capabilities);
}

/** Labels of the global memory scope; they name the server when `HostCapabilities.globalMemoryOnServer` is set. */
export function useMemoryScopeLabel() {
  const { t, te } = useI18n();
  const settingsStore = useSettingsStore();

  /** A locale key's variant for this host; route every key in `GLOBAL_SERVER_VARIANTS` through it. */
  const scopeKey = (key: string): string => memoryScopeKey(key, settingsStore.hostCapabilities);
  /** A stored scope value's label; an unknown value renders as stored. */
  const scopeLabel = (scope: string): string => {
    const key = `memory.scope.${scope}`;
    return te(key) ? t(scopeKey(key)) : scope;
  };
  const globalProfileLabel = computed(() => t(scopeKey('memoryAudit.profile.global')));

  return { scopeLabel, scopeKey, globalProfileLabel };
}
