import type { SettingsSectionId, SettingsTarget } from '@shared/settings-sections';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { StoreContext } from './message-handler/types';
import { usePlatformBridge } from './usePlatformBridge';

/** Opens settings where the host keeps them: the modal inside this page, or the desktop window's own overlay through core. */
export function openSettings(
  stores: Pick<StoreContext, 'settingsStore' | 'uiStore'>,
  postMessage: (message: WebviewToExtensionMessage) => void,
  target: SettingsTarget = {},
): void {
  if (stores.settingsStore.hostCapabilities.settingsInPanel) stores.uiStore.openSettingsModal(target);
  else postMessage({ type: 'openAppSettings', ...target });
}

export function useOpenSettings(): (section?: SettingsSectionId) => void {
  const stores = { settingsStore: useSettingsStore(), uiStore: useUIStore() };
  const { postMessage } = usePlatformBridge();
  return (section) => openSettings(stores, postMessage, section === undefined ? {} : { section });
}
