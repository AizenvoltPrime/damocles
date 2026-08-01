import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/** A pending pi-extension `ctx.ui.*` dialog request (US-026), minus the message discriminant. */
export type ExtensionUiRequest = Omit<Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>, 'type'>;

/**
 * FIFO queue of in-flight extension-UI dialog requests. Nested agents (subagents and team
 * specialists) elicit on the parent panel, so N requests can be open at once; only the head is
 * rendered. Removal is BY ID because the extension may withdraw a request that is not the head.
 */
export const useExtensionUiStore = defineStore('extensionUi', () => {
  const queue = ref<ExtensionUiRequest[]>([]);
  const current = computed(() => queue.value[0] ?? null);

  function setRequest(value: ExtensionUiRequest): void {
    if (queue.value.some((r) => r.requestId === value.requestId)) return;
    queue.value.push(value);
  }

  /** Drop one request wherever it sits — the head is not special, and an unknown id is a no-op. */
  function remove(requestId: string): void {
    queue.value = queue.value.filter((r) => r.requestId !== requestId);
  }

  // Two names for one behaviour, kept distinct because the CALLERS are: `resolve` follows an
  // `extensionUiResponse` this webview sent, `cancel` follows an `extensionUiCancel` the extension
  // sent. Both delegate rather than each filtering, so a future change to how removal works (say,
  // remembering answered ids) cannot land on one path and silently miss the other.

  /** The user answered this request. */
  function resolve(requestId: string): void {
    remove(requestId);
  }

  /** The extension withdrew this request (agent teardown, panel dispose, per-request abort). */
  function cancel(requestId: string): void {
    remove(requestId);
  }

  return { queue, current, setRequest, resolve, cancel };
});
