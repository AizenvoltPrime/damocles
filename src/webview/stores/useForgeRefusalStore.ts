import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

export type ForgeShellRefused = Extract<ExtensionToWebviewMessage, { type: 'forgeShellRefused' }>;

/** The account chosen from the notice's menu: saving until core's forgeRefusedBindResult, then saved or failed. */
export interface ForgeRefusalChoice {
  readonly accountId: string;
  readonly login: string;
  readonly state: 'saving' | 'saved' | 'failed';
}

export interface ForgeRefusal {
  readonly refused: ForgeShellRefused;
  readonly choice?: ForgeRefusalChoice;
}

/** A dock notice: the newest refusal of its server and reason, and every refusal it stands for, which its Dismiss takes. */
export interface DockedRefusal {
  readonly refusal: ForgeRefusal;
  readonly toolCallIds: readonly string[];
}

// Matches the refusals core keeps per panel for the notice's actions.
const MAX_REFUSALS = 50;

/** Whether the transcript shows a tool call's card; searched from the end, since it runs on every streamed update and a refused call is recent. */
export function transcriptHasCard(messages: readonly { readonly toolCalls?: readonly { readonly id: string }[] | undefined }[]): (toolCallId: string) => boolean {
  return (toolCallId) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.toolCalls?.some((call) => call.id === toolCallId)) return true;
    }
    return false;
  };
}

/**
 * The refused notices by toolCallId, ephemeral like the auth failure card: never stored in the session file, dropped with
 * the conversation. The choice lives here, so a notice the virtual list unmounts shows it again when it scrolls back.
 */
export const useForgeRefusalStore = defineStore('forgeRefusal', () => {
  const refusals = shallowRef<ReadonlyMap<string, ForgeRefusal>>(new Map());
  // a toast's Choose account: the notice for this toolCallId opens its menu, then clears it
  const menuRequest = ref<string | null>(null);

  function add(refused: ForgeShellRefused): void {
    const next = new Map(refusals.value);
    next.delete(refused.toolCallId);
    next.set(refused.toolCallId, { refused });
    while (next.size > MAX_REFUSALS) next.delete(next.keys().next().value!);
    refusals.value = next;
  }

  function update(toolCallId: string, choice: ForgeRefusalChoice): void {
    const current = refusals.value.get(toolCallId);
    if (!current) return;
    refusals.value = new Map(refusals.value).set(toolCallId, { ...current, choice });
  }

  function choose(toolCallId: string, accountId: string, login: string): void {
    update(toolCallId, { accountId, login, state: 'saving' });
  }

  function bindResult(toolCallId: string, accountId: string, ok: boolean): void {
    const choice = refusals.value.get(toolCallId)?.choice;
    // a later choice superseded this answer
    if (choice?.accountId !== accountId) return;
    update(toolCallId, { ...choice, state: ok ? 'saved' : 'failed' });
  }

  /** The refusals whose card the transcript does not show, one per server and reason (nested agents repeat them), newest last. */
  function docked(hasCard: (toolCallId: string) => boolean): DockedRefusal[] {
    const newest = new Map<string, DockedRefusal>();
    for (const refusal of refusals.value.values()) {
      if (hasCard(refusal.refused.toolCallId)) continue;
      const key = JSON.stringify([refusal.refused.serverId, refusal.refused.reason]);
      const toolCallIds = [...(newest.get(key)?.toolCallIds ?? []), refusal.refused.toolCallId];
      newest.delete(key);
      newest.set(key, { refusal, toolCallIds });
    }
    return [...newest.values()];
  }

  /** Dismiss in the dock: these notices go; core keeps its records, which only their actions read. */
  function dismiss(toolCallIds: readonly string[]): void {
    const next = new Map(refusals.value);
    for (const toolCallId of toolCallIds) next.delete(toolCallId);
    if (next.size !== refusals.value.size) refusals.value = next;
  }

  function requestMenu(toolCallId: string): void {
    menuRequest.value = refusals.value.has(toolCallId) ? toolCallId : null;
  }

  function menuOpened(): void {
    menuRequest.value = null;
  }

  function $reset(): void {
    refusals.value = new Map();
    menuRequest.value = null;
  }

  return { refusals, menuRequest, add, choose, bindResult, docked, dismiss, requestMenu, menuOpened, $reset };
});
