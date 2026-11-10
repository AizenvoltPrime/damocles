import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type {
  DesignApprovalScreen, DesignBriefView, DesignChange, DesignChatStateView, DesignCheckIssue, DesignFileInfo, DesignLinkStateView, DesignResultDecision, DesignResultView, UncheckedDecisionGroup,
} from '@shared/types/design';
import type { LocalizedText } from '@shared/localized-text';

interface CardPlacement {
  entryId: string;
  /** The transcript message the card follows; null when it came before any message. */
  afterMessageId: string | null;
  /** That message's timestamp, which places the card after the nearest earlier message once that one left the transcript. */
  afterTimestamp: number;
  /** Arrived as its entry committed, not from a history replay; only a live card plays its entrance. */
  live: boolean;
}

export type DesignTranscriptCard =
  | (CardPlacement & { kind: 'result'; result: DesignResultView })
  | (CardPlacement & { kind: 'brief'; brief: DesignBriefView });

/** A raised version prompt (PD-29), as `requestDesignVersionDecision` carries it. */
export interface DesignVersionPromptView {
  promptId: string;
  designId: string;
  fromVersion: number;
  toVersion: number;
  changes: DesignChange[];
}

/** A raised FinishDesign approval prompt, as `requestDesignApproval` carries it. */
export interface DesignApprovalPromptView {
  promptId: string;
  designId: string;
  summary: string;
  previousVersion: number | null;
  changes: DesignChange[];
  warnings: DesignCheckIssue[];
  decisions: DesignResultDecision[];
  screens: DesignApprovalScreen[];
  hasParent: boolean;
  /** Decisions the conflict check could not check, grouped by cause, which the user approves knowingly. */
  uncheckedDecisions?: UncheckedDecisionGroup[];
}

export interface DesignFileList {
  files: DesignFileInfo[];
  loaded: boolean;
  /** A request is out for a list already held, which stays shown meanwhile. */
  refreshing: boolean;
  /** Core could not list the folder; it said so in a notification too. */
  failed: boolean;
}

/** A PreviewJourney call's replay in the preview tab, from the click until `designJourneyReplayed` answers it. */
export type DesignJourneyReplay =
  | { state: 'replaying' }
  | { state: 'replayed' }
  | { state: 'refused'; error: LocalizedText | null };

export const useDesignStore = defineStore('design', () => {
  // Session state from core's one publisher (`designState`); kept across a replay of the same conversation.
  const design = shallowRef<DesignChatStateView | null>(null);
  const link = shallowRef<DesignLinkStateView | null>(null);
  // The host's rule set opens designs in the browser from the chat's buttons (`designState.openInBrowser`).
  const openInBrowser = ref(false);
  // The host's rule set opens a screen in the preview tab from the chat's buttons (`designState.openPreview`).
  const openPreview = ref(false);
  // Transcript cards, in arrival order, which is their branch order; replaced, never mutated in place.
  const cards = shallowRef<readonly DesignTranscriptCard[]>([]);
  const fileLists = ref<Record<string, DesignFileList>>({});
  const versionPrompts = ref<DesignVersionPromptView[]>([]);
  const approvalPrompts = ref<DesignApprovalPromptView[]>([]);
  // Keyed by the PreviewJourney call's id, so it lives as long as the conversation.
  const journeyReplays = ref<Record<string, DesignJourneyReplay>>({});

  function setState(nextDesign: DesignChatStateView | null, nextLink: DesignLinkStateView | null): void {
    design.value = nextDesign;
    link.value = nextLink;
  }

  function setOpenInBrowser(value: boolean): void {
    openInBrowser.value = value;
  }

  function setOpenPreview(value: boolean): void {
    openPreview.value = value;
  }

  function addCard(card: DesignTranscriptCard): void {
    const index = cards.value.findIndex((existing) => existing.entryId === card.entryId);
    cards.value = index === -1 ? [...cards.value, card] : cards.value.map((existing, at) => (at === index ? card : existing));
  }

  // A list already held stays shown while its refresh is out, so an open menu does not jump to the loading line and back.
  function filesRequested(designId: string): void {
    const held = fileLists.value[designId];
    fileLists.value[designId] = held?.loaded ? { ...held, refreshing: true } : { files: [], loaded: false, refreshing: false, failed: false };
  }

  function setFiles(designId: string, files: DesignFileInfo[], failed: boolean): void {
    fileLists.value[designId] = { files, loaded: true, refreshing: false, failed };
  }

  // Core posts every pending prompt again when a view attaches, so a known prompt id is the same prompt.
  function addVersionPrompt(prompt: DesignVersionPromptView): void {
    if (versionPrompts.value.some((pending) => pending.promptId === prompt.promptId)) return;
    versionPrompts.value = [...versionPrompts.value, prompt];
  }

  function removeVersionPrompt(promptId: string): void {
    versionPrompts.value = versionPrompts.value.filter((pending) => pending.promptId !== promptId);
  }

  // As with version prompts, a prompt id core posts again on a view's attach is the prompt already held.
  function addApprovalPrompt(prompt: DesignApprovalPromptView): void {
    if (approvalPrompts.value.some((pending) => pending.promptId === prompt.promptId)) return;
    approvalPrompts.value = [...approvalPrompts.value, prompt];
  }

  function removeApprovalPrompt(promptId: string): void {
    approvalPrompts.value = approvalPrompts.value.filter((pending) => pending.promptId !== promptId);
  }

  function replayStarted(toolCallId: string): void {
    journeyReplays.value[toolCallId] = { state: 'replaying' };
  }

  // A reply for a call this conversation never replayed (a reset since the click) is dropped.
  function replayEnded(toolCallId: string, ok: boolean, error: LocalizedText | undefined): void {
    if (journeyReplays.value[toolCallId] === undefined) return;
    journeyReplays.value[toolCallId] = ok ? { state: 'replayed' } : { state: 'refused', error: error ?? null };
  }

  function resetConversation(): void {
    cards.value = [];
    versionPrompts.value = [];
    approvalPrompts.value = [];
    journeyReplays.value = {};
  }

  function $reset(): void {
    design.value = null;
    link.value = null;
    openInBrowser.value = false;
    openPreview.value = false;
    cards.value = [];
    fileLists.value = {};
    versionPrompts.value = [];
    approvalPrompts.value = [];
    journeyReplays.value = {};
  }

  return {
    design, link, openInBrowser, openPreview, cards, fileLists, versionPrompts, approvalPrompts, journeyReplays,
    setState, setOpenInBrowser, setOpenPreview, addCard, filesRequested, setFiles, addVersionPrompt, removeVersionPrompt, addApprovalPrompt, removeApprovalPrompt,
    replayStarted, replayEnded,
    resetConversation, $reset,
  };
});
