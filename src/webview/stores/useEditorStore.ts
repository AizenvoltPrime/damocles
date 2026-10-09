import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage, SettingsFileAvailability, SettingsFileScope } from '@shared/types/messages';

type ShowDiff = Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>;

export type EditorView = Omit<ShowDiff, 'type'>;

/**
 * The chat panel's editor overlay (D15): approval diffs only, held by approval id until their permission card's Open diff
 * opens one, plus which settings files the settings modal's Edit settings.json may open. Every entry is replaced, never
 * mutated, so a watcher on it sees each message, and document text stays out of deep reactivity.
 */
export const useEditorStore = defineStore('editor', () => {
  const view = shallowRef<EditorView | null>(null);
  /** Proposal diffs by approval id until the host closes them. Each opens only from its permission card, since a modal the agent opened would take focus from the user's typing. */
  const proposals = shallowRef<ReadonlyMap<string, EditorView>>(new Map());
  const settingsFileAvailability = shallowRef<Record<SettingsFileScope, SettingsFileAvailability> | null>(null);
  const hasOpenOverlay = computed(() => view.value !== null);

  function showDiff({ type: _type, ...rest }: ShowDiff): void {
    proposals.value = new Map(proposals.value).set(rest.approvalId, rest);
  }

  /** The host closed `viewId`; a view that has since been replaced stays open. */
  function closeView(viewId: string): void {
    if (view.value?.viewId === viewId) view.value = null;
    const held = [...proposals.value].find(([, proposal]) => proposal.viewId === viewId);
    if (held) {
      const rest = new Map(proposals.value);
      rest.delete(held[0]);
      proposals.value = rest;
    }
  }

  // Closing a proposal decides nothing, so it stays held for its card until the host closes it.
  function dismissView(): void {
    view.value = null;
  }

  /** Shows the proposal diff held for `approvalId`; false when there is none. */
  function openProposal(approvalId: string): boolean {
    const proposal = proposals.value.get(approvalId);
    if (!proposal) return false;
    view.value = proposal;
    return true;
  }

  function setSettingsFileAvailability(files: Record<SettingsFileScope, SettingsFileAvailability>): void {
    settingsFileAvailability.value = files;
  }

  return {
    view,
    settingsFileAvailability,
    hasOpenOverlay,
    showDiff,
    closeView,
    dismissView,
    openProposal,
    setSettingsFileAvailability,
  };
});
