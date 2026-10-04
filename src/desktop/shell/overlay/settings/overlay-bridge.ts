import { SETTINGS_VIEW_REQUEST_TYPES } from '@shared/settings-view-messages';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import type { PlatformBridge } from '@/composables/usePlatformBridge';
import type { DamoclesOverlayApi } from '../../../preload/overlay-channels';

export interface OverlaySettingsBridge extends PlatformBridge {
  /** The attachment the next sends belong to; main drops a send whose generation is no longer current. */
  setGeneration(generation: number): void;
}

/**
 * The webview's platform bridge for the settings components the overlay mounts: messages go to the chat main attached
 * this view to (C6 settings:send), and the chat's settings messages come back (settings:message). Nothing is persisted.
 */
export function createOverlaySettingsBridge(api: DamoclesOverlayApi): OverlaySettingsBridge {
  let generation: number | null = null;
  let state: unknown;
  return {
    setGeneration(next) {
      generation = next;
    },
    postMessage(message: WebviewToExtensionMessage) {
      // A settings component sending anything else is a bug here; main would refuse it as well.
      if (!SETTINGS_VIEW_REQUEST_TYPES.has(message.type)) throw new Error(`The settings view may not send ${message.type}`);
      if (generation === null) throw new Error(`The settings view sent ${message.type} before it was attached to a chat`);
      api.settingsSend(generation, message);
    },
    onMessage(handler: (message: ExtensionToWebviewMessage) => void) {
      return api.onSettingsMessage(handler);
    },
    getState<T>() {
      return state as T | undefined;
    },
    setState<T>(next: T) {
      state = next;
    },
  };
}
