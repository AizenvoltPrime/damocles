import { computed, reactive, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionToWebviewMessage, SettingsFileAvailability, SettingsFileScope, SettingsFileState } from '@shared/types/messages';

type ShowDiff = Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>;
type OpenFile = Extract<ExtensionToWebviewMessage, { type: 'editorOpenFile' }>;
type SaveResultMessage = Extract<ExtensionToWebviewMessage, { type: 'settingsFileSaveResult' }>;

export type EditorView =
  | ({ kind: 'diff' } & Omit<ShowDiff, 'type'>)
  | ({ kind: 'file' } & Omit<OpenFile, 'type'>);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SettingsSaveResult = DistributiveOmit<SaveResultMessage, 'type' | 'scope'>;

/**
 * The chat panel's editor overlays: at most one open view (a new one replaces it), the proposal diffs
 * held for their permission cards, and the settings JSON editor, plus the settings-file state the host
 * sent. Every entry is replaced, never mutated, so a watcher on it sees each message, and document text
 * stays out of deep reactivity.
 */
export const useEditorStore = defineStore('editor', () => {
  const view = shallowRef<EditorView | null>(null);
  /** Proposal diffs by approval id until the host closes them. Each opens only from its permission card, since a modal the agent opened would take focus from the user's typing. */
  const proposals = shallowRef<ReadonlyMap<string, Extract<EditorView, { kind: 'diff' }>>>(new Map());
  const settingsEditorScope = shallowRef<SettingsFileScope | null>(null);
  const settingsFiles = reactive<Partial<Record<SettingsFileScope, SettingsFileState>>>({});
  const saveResults = reactive<Partial<Record<SettingsFileScope, SettingsSaveResult>>>({});
  const changedVersions = reactive<Partial<Record<SettingsFileScope, { version: string }>>>({});
  const settingsFileAvailability = shallowRef<Record<SettingsFileScope, SettingsFileAvailability> | null>(null);
  /** Another scope was asked for while the editor is open; the open editor switches to it, asking first when it has unsaved edits. */
  const requestedSettingsScope = shallowRef<SettingsFileScope | null>(null);
  const hasOpenOverlay = computed(() => view.value !== null || settingsEditorScope.value !== null);

  function showDiff({ type: _type, ...rest }: ShowDiff): void {
    const diff = { kind: 'diff' as const, ...rest };
    if (diff.purpose === 'proposal' && diff.approvalId !== undefined) proposals.value = new Map(proposals.value).set(diff.approvalId, diff);
    else view.value = diff;
  }

  function openFile({ type: _type, ...rest }: OpenFile): void {
    view.value = { kind: 'file', ...rest };
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

  function setSettingsFile(file: SettingsFileState): void {
    settingsFiles[file.scope] = file;
  }

  function setSaveResult({ type: _type, scope, ...result }: SaveResultMessage): void {
    saveResults[scope] = result;
  }

  function noteSettingsFileChanged(scope: SettingsFileScope, version: string): void {
    changedVersions[scope] = { version };
  }

  function setSettingsFileAvailability(files: Record<SettingsFileScope, SettingsFileAvailability>): void {
    settingsFileAvailability.value = files;
  }

  // The editor loads fresh content on open, so nothing from an earlier load or save may reach it.
  function showSettingsEditor(scope: SettingsFileScope): void {
    delete settingsFiles[scope];
    delete saveResults[scope];
    delete changedVersions[scope];
    requestedSettingsScope.value = null;
    settingsEditorScope.value = scope;
  }

  /** Opens `scope`. An open editor is never replaced here: on its own scope it stays as it is, and another scope becomes a request it answers. */
  function openSettingsEditor(scope: SettingsFileScope): void {
    const open = settingsEditorScope.value;
    if (open === null) showSettingsEditor(scope);
    else requestedSettingsScope.value = open === scope ? null : scope;
  }

  /** Called by the open editor once it has no edits to lose, or the user chose to discard them. */
  function switchToRequestedSettingsFile(): void {
    const scope = requestedSettingsScope.value;
    if (scope !== null) showSettingsEditor(scope);
  }

  function cancelSettingsFileRequest(): void {
    requestedSettingsScope.value = null;
  }

  function closeSettingsEditor(): void {
    requestedSettingsScope.value = null;
    settingsEditorScope.value = null;
  }

  return {
    view,
    settingsEditorScope,
    settingsFiles,
    saveResults,
    changedVersions,
    settingsFileAvailability,
    requestedSettingsScope,
    hasOpenOverlay,
    showDiff,
    openFile,
    closeView,
    dismissView,
    openProposal,
    setSettingsFile,
    setSaveResult,
    noteSettingsFileChanged,
    setSettingsFileAvailability,
    openSettingsEditor,
    switchToRequestedSettingsFile,
    cancelSettingsFileRequest,
    closeSettingsEditor,
  };
});
