import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/** A pending pi-extension `ctx.ui.*` dialog request (US-026), minus the message discriminant. */
export type ExtensionUiRequest = Omit<Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>, 'type'>;

/** Holds the single in-flight extension-UI dialog (pi processes them one at a time per session). */
export const useExtensionUiStore = defineStore('extensionUi', () => {
  const request = ref<ExtensionUiRequest | null>(null);

  function setRequest(value: ExtensionUiRequest): void {
    request.value = value;
  }

  function clear(): void {
    request.value = null;
  }

  return { request, setRequest, clear };
});
