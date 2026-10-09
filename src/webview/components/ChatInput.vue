<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Component } from "vue";
import { toast } from "vue-sonner";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import type { PermissionMode } from "@shared/types/settings";
import type { UserContentBlock } from "@shared/types/content";
import { ArrowUp, AtSign, CheckCheck, ClipboardList, Code, Eye, LoaderCircle, LockOpen, Mic, Paperclip, Pencil } from "lucide-vue-next";
import { FILE_DRAG_MIME, parseFileDragPayload } from "@shared/file-drag";
import { usePromptHistory } from "@/composables/usePromptHistory";
import { useAtMentionAutocomplete } from "@/composables/useAtMentionAutocomplete";
import { useSlashCommandAutocomplete } from "@/composables/useSlashCommandAutocomplete";
import { useImageAttachments, type ImageAttachment } from "@/composables/useImageAttachments";
import { useElementAttachments, elementAttachmentBus } from "@/composables/useElementAttachments";
import { useVoiceInput } from "@/composables/useVoiceInput";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { DOCK_PROMPT_SELECTOR } from "@/composables/useDockPrompt";
import { useUIStore } from "@/stores/useUIStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import type { CpuFallbackReason } from "@/stores/useVoiceJarvisStore";
import { useStreamingStore } from "@/stores/useStreamingStore";
import { parseSteerCommand, type SteerRequest } from "@/utils/steer-command";
import AtMentionPopup from "./AtMentionPopup.vue";
import SlashCommandPopup from "./SlashCommandPopup.vue";
import ImageThumbnailStrip from "./ImageThumbnailStrip.vue";
import ElementAttachmentStrip from "./ElementAttachmentStrip.vue";
import TerminalAttachmentStrip from "./TerminalAttachmentStrip.vue";
import ModelEffortPopover from "./composer/ModelEffortPopover.vue";

const { t } = useI18n();
const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const streamingStore = useStreamingStore();

const props = defineProps<{
  isProcessing: boolean;
  permissionMode: PermissionMode;
  dangerouslySkipPermissions: boolean;
  settingsOpen?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string | UserContentBlock[], includeIdeContext: boolean, terminalAttachmentIds: string[]];
  queue: [content: string | UserContentBlock[]];
  steer: [steer: SteerRequest, requestId: string];
  cancel: [];
  changeMode: [mode: PermissionMode];
  toggleDangerouslySkipPermissions: [];
}>();

const inputText = ref("");
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const cardRef = ref<HTMLDivElement | null>(null);

const {
  isOpen: atMentionOpen,
  query: atMentionQuery,
  selectedIndex: atMentionSelectedIndex,
  filteredItems: atMentionItems,
  isLoading: atMentionLoading,
  checkAndUpdateMention,
  handleKeyDown: handleAtMentionKeyDown,
  selectItem: selectAtMentionItem,
  close: closeAtMention,
} = useAtMentionAutocomplete(inputText, textareaRef);

const {
  isOpen: slashCommandOpen,
  query: slashCommandQuery,
  selectedIndex: slashCommandSelectedIndex,
  filteredCommands: slashCommandCommands,
  isLoading: slashCommandLoading,
  mode: slashCommandMode,
  agents: slashCommandAgents,
  agentsLoading: slashCommandAgentsLoading,
  checkAndUpdateSlashCommand,
  handleKeyDown: handleSlashCommandKeyDown,
  selectItem: selectSlashCommandItem,
  close: closeSlashCommand,
} = useSlashCommandAutocomplete(inputText, textareaRef);

const {
  attachments: imageAttachments,
  hasAttachments: hasImageAttachments,
  addFromFile: addImageFromFile,
  addFromClipboard: addImageFromClipboard,
  addFromBlock: addImageFromBlock,
  remove: removeImage,
  clear: clearImages,
  toContentBlocks: imagesToContentBlocks,
} = useImageAttachments();

const {
  attachments: elementAttachments,
  hasAttachments: hasElementAttachments,
  add: addElement,
  remove: removeElement,
  clear: clearElements,
  toContentBlocks: elementsToContentBlocks,
} = useElementAttachments();

const {
  status: voiceStatus,
  startRecording,
  setRecording: voiceSetRecording,
  stopRecording,
  cancelRecording,
  setDone: voiceSetDone,
  setError: voiceSetError,
} = useVoiceInput();

const { postMessage } = usePlatformBridge();

// A file dragged from the desktop sidebar or an editor tab: the composer shows a drop target, and core resolves the drop into
// the same mention an @ pick inserts (insertMention). Counting enters and leaves keeps the target up over child elements.
const fileDropDepth = ref(0);
const fileDropping = computed(() => fileDropDepth.value > 0);
const carriesFile = (event: DragEvent): boolean =>
  settingsStore.hostCapabilities.fileMentionDrop && (event.dataTransfer?.types.includes(FILE_DRAG_MIME) ?? false);

function onFileDragEnter(event: DragEvent): void {
  if (!carriesFile(event)) return;
  event.preventDefault();
  fileDropDepth.value++;
}

function onFileDragOver(event: DragEvent): void {
  if (!carriesFile(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onFileDragLeave(event: DragEvent): void {
  if (!carriesFile(event)) return;
  fileDropDepth.value = Math.max(0, fileDropDepth.value - 1);
}

function onFileDrop(event: DragEvent): void {
  fileDropDepth.value = 0;
  if (!carriesFile(event)) return;
  event.preventDefault();
  const payload = parseFileDragPayload(event.dataTransfer?.getData(FILE_DRAG_MIME));
  if (payload) postMessage({ type: "mentionDropped", projectKey: payload.projectKey, relativePath: payload.relativePath });
}

const voiceJarvisStore = useVoiceJarvisStore();
const {
  state: jarvisState,
  muted: jarvisMuted,
  errorMessage: jarvisErrorMessage,
  cpuFallbackReason: jarvisCpuFallbackReason,
} = storeToRefs(voiceJarvisStore);

const isWakeMode = computed(() => settingsStore.voiceConfig.mode === "wake-word");

const CPU_FALLBACK_KEYS: Record<CpuFallbackReason, string> = {
  "no-cuda": "chatInput.voice.wake.cpuFallback.noCuda",
  "low-vram": "chatInput.voice.wake.cpuFallback.lowVram",
  "user-pref": "chatInput.voice.wake.cpuFallback.userPref",
  "cuda-oom-fallback": "chatInput.voice.wake.cpuFallback.cudaOomFallback",
  "tts-unloaded": "chatInput.voice.wake.cpuFallback.ttsUnloaded",
};

function handleVoiceToggle() {
  if (isWakeMode.value) {
    if (voiceMicDisabled.value) return;
    const next = !jarvisMuted.value;
    voiceJarvisStore.setMuted(next);
    postMessage({ type: "voiceStreamMute", muted: next });
    return;
  }
  if (voiceStatus.value === "idle") {
    startRecording();
  } else if (voiceStatus.value === "recording") {
    stopRecording();
  } else if (voiceStatus.value === "error") {
    cancelRecording();
  }
}

function appendTranscription(text: string) {
  const current = inputText.value;
  inputText.value = current ? current + " " + text : text;
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

const voiceTooltip = computed(() => {
  if (isWakeMode.value) {
    if (jarvisState.value === "off") return t("chatInput.voice.wake.off");
    if (jarvisState.value === "loading") return t("chatInput.voice.wake.loading");
    if (jarvisState.value === "error") return jarvisErrorMessage.value ?? t("chatInput.voice.wake.error");
    if (jarvisMuted.value || jarvisState.value === "muted") return t("chatInput.voice.wake.unmute");
    if (jarvisState.value === "recording") return t("chatInput.voice.wake.recording");
    if (jarvisState.value === "cpu-fallback") {
      const reason = jarvisCpuFallbackReason.value;
      return reason !== null ? t(CPU_FALLBACK_KEYS[reason]) : t("chatInput.voice.wake.cpu");
    }
    return t("chatInput.voice.wake.listening");
  }
  if (!settingsStore.voiceHasApiKey) return t("chatInput.voice.noApiKey");
  if (voiceStatus.value === "starting") return t("chatInput.voice.starting");
  if (voiceStatus.value === "recording") return t("chatInput.voice.stopRecording");
  if (voiceStatus.value === "transcribing") return t("chatInput.voice.transcribing");
  return t("chatInput.voice.startRecording");
});

const voiceMicDisabled = computed(() => {
  if (isWakeMode.value) {
    return jarvisState.value === "off"
      || jarvisState.value === "loading"
      || jarvisState.value === "error";
  }
  return !settingsStore.voiceHasApiKey
    || voiceStatus.value === "transcribing"
    || voiceStatus.value === "starting";
});

const micButtonClass = computed(() => {
  if (isWakeMode.value) {
    if (jarvisState.value === "error") return "text-(--d-danger)";
    if (jarvisState.value === "off") return "opacity-50";
    if (jarvisMuted.value || jarvisState.value === "muted") return "opacity-60";
    if (jarvisState.value === "recording") return "d-ring text-(--d-danger) bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)]";
    if (jarvisState.value === "cpu-fallback") return "text-(--d-warning)";
    if (jarvisState.value === "loading") return "";
    return "text-(--d-success)";
  }
  if (voiceStatus.value === "recording") return "d-ring text-(--d-danger) bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)]";
  if (voiceStatus.value === "error") return "text-(--d-warning)";
  return "";
});

const micShowsSpinner = computed(() => {
  if (isWakeMode.value) return jarvisState.value === "loading";
  return voiceStatus.value === "transcribing" || voiceStatus.value === "starting";
});

function isCursorAtStart(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart === 0;
}

function isCursorAtEnd(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart === textarea.value.length;
}

const {
  isNavigating,
  currentEntry,
  shouldRestoreOriginal,
  navigateUp,
  navigateDown,
  reset: resetHistory,
  captureOriginal,
  getOriginalInput,
  clearRestoreFlag,
  addEntry,
} = usePromptHistory();

watch(currentEntry, (entry) => {
  if (entry !== null) {
    inputText.value = entry;
  } else if (shouldRestoreOriginal.value) {
    inputText.value = getOriginalInput();
    clearRestoreFlag();
  }
});

function focus() {
  textareaRef.value?.focus();
}

function setInput(value: string) {
  inputText.value = value;
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

/** Puts `prefix` before the draft with the caret still on the same text; a draft that already starts with it is left alone. */
function prependInput(prefix: string) {
  const textarea = textareaRef.value;
  const shift = inputText.value.startsWith(prefix) ? 0 : prefix.length;
  const start = (textarea?.selectionStart ?? 0) + shift;
  const end = (textarea?.selectionEnd ?? 0) + shift;
  if (shift) inputText.value = prefix + inputText.value;
  nextTick(() => {
    textarea?.focus();
    textarea?.setSelectionRange(start, end);
  });
}

const heldSteerDrafts = new Map<string, { text: string; images: ImageAttachment[] }>();

function holdSteerDraft(): string {
  const requestId = `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  heldSteerDrafts.set(requestId, { text: inputText.value, images: [...imageAttachments.value] });
  return requestId;
}

function settleSteer(requestId: string, delivered: boolean): void {
  const draft = heldSteerDrafts.get(requestId);
  heldSteerDrafts.delete(requestId);
  if (!draft || delivered || canSend.value) return;
  inputText.value = draft.text;
  imageAttachments.value = draft.images;
}

/** Put an unsent queued message back after whatever the box already holds, so nothing typed since is lost. */
function restoreQueued(blocks: readonly UserContentBlock[]): void {
  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
  if (text) inputText.value = inputText.value ? `${inputText.value}\n\n${text}` : text;
  for (const block of blocks) if (block.type === "image") void addImageFromBlock(block);
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

defineExpose({ focus, setInput, prependInput, submit: handleSend, sendPrompt, appendTranscription, voiceSetRecording, voiceSetDone, voiceSetError, settleSteer, restoreQueued });

// One composer per page, so fixed ids tie the textarea to whichever autocomplete list is open.
const MENTION_LIST_ID = "composer-mentions";
const COMMAND_LIST_ID = "composer-commands";
const autocompleteListId = computed(() => (slashCommandOpen.value ? COMMAND_LIST_ID : atMentionOpen.value ? MENTION_LIST_ID : undefined));
const activeOptionId = computed(() => {
  if (slashCommandOpen.value) {
    const count = slashCommandMode.value === "agent" ? slashCommandAgents.value.length : slashCommandCommands.value.length;
    return slashCommandSelectedIndex.value < count ? `${COMMAND_LIST_ID}-${slashCommandSelectedIndex.value}` : undefined;
  }
  if (atMentionOpen.value) return atMentionSelectedIndex.value < atMentionItems.value.length ? `${MENTION_LIST_ID}-${atMentionSelectedIndex.value}` : undefined;
  return undefined;
});

const canSend = computed(() => inputText.value.trim().length > 0 || hasImageAttachments.value || hasElementAttachments.value);

const modeConfig = computed<Record<PermissionMode, { icon: Component; label: string; color: string }>>(() => ({
  default: { icon: Pencil, label: t("chatInput.permissionModes.default.label"), color: "text-(--d-muted)" },
  acceptEdits: { icon: CheckCheck, label: t("chatInput.permissionModes.acceptEdits.label"), color: "text-(--d-success) hover:text-(--d-success-text)" },
  plan: { icon: ClipboardList, label: t("chatInput.permissionModes.plan.label"), color: "text-(--d-info) hover:text-(--d-info-text)" },
}));

const modeOrder = computed<PermissionMode[]>(() => ["default", "acceptEdits", "plan"]);

const currentModeConfig = computed(() => modeConfig.value[props.permissionMode]);
const modeIndex = computed(() => Math.max(0, modeOrder.value.indexOf(props.permissionMode)));

function cycleMode() {
  const order = modeOrder.value;
  const currentIndex = order.indexOf(props.permissionMode);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % order.length;
  const nextMode = order[nextIndex];
  if (nextMode) emit("changeMode", nextMode);
}

function toggleDangerouslySkipPermissions() {
  emit("toggleDangerouslySkipPermissions");
}

const ideContextLabel = computed(() => {
  const ctx = uiStore.ideContext;
  if (!ctx) return t("common.noFile");
  if (ctx.type === "selection" && ctx.lineCount) {
    return t("chatInput.lineCount", { n: ctx.lineCount }, ctx.lineCount);
  }
  return ctx.fileName;
});

const ideContextEnabled = computed(() => {
  return !!(uiStore.ideContext && uiStore.ideContextEnabled);
});

const ideContextTooltip = computed(() => {
  const ctx = uiStore.ideContext;
  const action = ideContextEnabled.value ? t("chatInput.excludeContext") : t("chatInput.includeContext");
  if (!ctx) return action;
  return `${ctx.filePath}\n\n${action}`;
});

function toggleIdeContext() {
  uiStore.toggleIdeContext();
}

const fileInputRef = ref<HTMLInputElement | null>(null);

async function attachChosenImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  for (const file of files) {
    const result = await addImageFromFile(file);
    if (result.error) toast.error(result.error);
  }
  textareaRef.value?.focus();
}

function handleSend() {
  // A prompt sent mid-switch would land in a fresh session in another folder; the draft stays in the box.
  if (!canSend.value || settingsStore.workspaceFolderSwitchPending) return;
  const text = inputText.value.trim();

  const imageBlocks = imagesToContentBlocks();
  const elementBlocks = elementsToContentBlocks();
  const hasBlocks = imageBlocks.length > 0 || elementBlocks.length > 0;
  const content: string | UserContentBlock[] = hasBlocks
    ? [...elementBlocks, ...imageBlocks, ...(text ? [{ type: "text" as const, text }] : [])]
    : text;

  // A rejected steer returns before addEntry and the clear below, so the draft stays in the box.
  const steer = parseSteerCommand(content);
  if (steer.kind === "usage" || steer.kind === "elements") {
    streamingStore.addErrorMessage(t(steer.kind === "usage" ? "steerCommand.usage" : "steerCommand.noElements"));
    return;
  }
  addEntry(text);

  if (steer.kind === "steer") {
    emit("steer", { agentId: steer.agentId, message: steer.message, images: steer.images }, holdSteerDraft());
  } else {
    dispatch(content, uiStore.terminalAttachments.map((attachment) => attachment.id));
  }

  inputText.value = "";
  clearImages();
  clearElements();
  resetHistory();
}

// Terminal attachments go only with a message sent now; a queued one leaves the chips for the next send.
function dispatch(content: string | UserContentBlock[], terminalAttachmentIds: string[] = []) {
  if (props.isProcessing) emit("queue", content);
  else emit("send", content, ideContextEnabled.value, terminalAttachmentIds);
}

function removeTerminalAttachment(id: string) {
  postMessage({ type: "removeTerminalAttachment", id });
}

/** Sends `prompt` on its own; the draft and its attachments stay staged in the box. */
function sendPrompt(prompt: string) {
  if (settingsStore.workspaceFolderSwitchPending) return;
  dispatch(prompt);
}

function handleButtonClick() {
  if (canSend.value) {
    handleSend();
  } else if (props.isProcessing) {
    handleCancel();
  }
}

function handleKeydown(event: KeyboardEvent) {
  // An IME commits its candidate with Enter, and Windows reports that commit as keyCode 229 only.
  if (event.isComposing || event.keyCode === 229) return;

  // Only a bare Shift+Tab cycles the mode; Ctrl/Cmd/Alt+Shift+Tab belong to the host (previous tab or editor).
  if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    cycleMode();
    return;
  }

  if (slashCommandOpen.value) {
    if (["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"].includes(event.key)) {
      const handled = handleSlashCommandKeyDown(event);
      if (handled) {
        event.preventDefault();
        return;
      }
    }
  }

  if (atMentionOpen.value) {
    if (["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"].includes(event.key)) {
      const handled = handleAtMentionKeyDown(event);
      if (handled) {
        event.preventDefault();
        return;
      }
    }
  }

  if (event.key === "Enter") {
    if (event.shiftKey) {
      event.preventDefault();
      const textarea = textareaRef.value;
      if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        inputText.value = inputText.value.substring(0, start) + "\n" + inputText.value.substring(end);
        nextTick(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
          textarea.scrollTop = textarea.scrollHeight;
        });
      }
    } else {
      event.preventDefault();
      event.stopPropagation();
      handleSend();
    }
    return;
  }

  if (event.key === "ArrowUp") {
    event.stopPropagation();
    const textarea = textareaRef.value;
    if (textarea && (textarea.value === "" || isCursorAtStart(textarea))) {
      event.preventDefault();
      captureOriginal(inputText.value);
      navigateUp();
    }
    return;
  }

  if (event.key === "ArrowDown") {
    event.stopPropagation();
    const textarea = textareaRef.value;
    if (isNavigating.value && textarea && isCursorAtEnd(textarea)) {
      event.preventDefault();
      navigateDown();
    }
    return;
  }
}

function handleInput() {
  if (isNavigating.value) {
    resetHistory();
  }
  checkAndUpdateMention();
  checkAndUpdateSlashCommand();
}

async function handlePaste(event: ClipboardEvent) {
  if (!event.clipboardData) return;

  const hasImages = Array.from(event.clipboardData.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));

  if (hasImages) {
    event.preventDefault();
    await addImageFromClipboard(event.clipboardData);
  }
}

function handleCancel() {
  emit("cancel");
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.isProcessing || props.settingsOpen) {
    return;
  }
  // Escape inside a dialog or a dock prompt card belongs to that card, never to the run.
  if (event.target instanceof Element && event.target.closest(`[role="dialog"], [role="alertdialog"], ${DOCK_PROMPT_SELECTOR}`)) {
    return;
  }
  event.preventDefault();
  handleCancel();
}

let unsubBus: (() => void) | null = null;

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeydown);
  unsubBus = elementAttachmentBus.on(addElement);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
  unsubBus?.();
});
</script>

<template>
  <div class="@container relative shrink-0">
    <AtMentionPopup
      :is-open="atMentionOpen"
      :items="atMentionItems"
      v-model:selected-index="atMentionSelectedIndex"
      :list-id="MENTION_LIST_ID"
      :anchor-element="cardRef"
      :query="atMentionQuery"
      :is-loading="atMentionLoading"
      @select="selectAtMentionItem(atMentionItems.indexOf($event))"
      @close="closeAtMention"
    />

    <SlashCommandPopup
      :is-open="slashCommandOpen"
      :commands="slashCommandCommands"
      v-model:selected-index="slashCommandSelectedIndex"
      :list-id="COMMAND_LIST_ID"
      :anchor-element="cardRef"
      :query="slashCommandQuery"
      :is-loading="slashCommandMode === 'agent' ? slashCommandAgentsLoading : slashCommandLoading"
      :mode="slashCommandMode"
      :agents="slashCommandAgents"
      @select="selectSlashCommandItem($event)"
      @close="closeSlashCommand"
    />

    <div
      ref="cardRef"
      class="group/composer relative rounded-2xl border border-(--d-border2) bg-(--d-input) shadow-[0_1px_2px_rgb(0_0_0/.15)] transition-colors duration-200 focus-within:border-(--d-accent)"
      data-testid="composer"
      :data-file-drop="fileDropping || undefined"
      @dragenter="onFileDragEnter"
      @dragover="onFileDragOver"
      @dragleave="onFileDragLeave"
      @drop="onFileDrop"
    >
      <Transition name="t-fade">
        <div
          v-if="fileDropping"
          data-testid="composer-drop-target"
          class="composer-drop-target pointer-events-none absolute inset-0 z-5 flex items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-(--d-accent) bg-(--d-accent-soft) font-medium text-(--d-accent-text)"
        >
          <AtSign
            aria-hidden="true"
            class="size-3.75"
          />
          {{ t("composer.dropToMention") }}
        </div>
      </Transition>
      <span
        class="pointer-events-none absolute -inset-1.25 rounded-[1.25rem] border-4 border-(--d-accent-soft) opacity-0 transition-opacity duration-200 group-focus-within/composer:opacity-100"
        aria-hidden="true"
      />
      <TerminalAttachmentStrip
        :attachments="uiStore.terminalAttachments"
        @remove="removeTerminalAttachment"
        @focus-composer="focus"
      />
      <ElementAttachmentStrip
        :attachments="elementAttachments"
        @remove="removeElement"
      />
      <ImageThumbnailStrip
        :attachments="imageAttachments"
        @remove="removeImage"
      />

      <!-- field-sizing ignores rows, so min-h is the two rows plus pt-3 and pb-1.5, rounded to whole px at the default font. -->
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :placeholder="isProcessing ? t('chatInput.placeholderQueued') : t('chatInput.placeholder')"
        :aria-label="t('composer.inputLabel')"
        aria-autocomplete="list"
        :aria-controls="autocompleteListId"
        :aria-activedescendant="activeOptionId"
        rows="2"
        class="relative block max-h-50 min-h-[round(calc(2lh+1.125rem),0.0625rem)] w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-3.5 pb-1.5 pt-3 text-13.5 leading-[1.55] text-(--d-text) outline-none field-sizing-content placeholder:text-(--d-faint) focus-visible:outline-none"
        @keydown="handleKeydown"
        @input="handleInput"
        @paste="handlePaste"
      />

      <!-- The row wraps, so it never overflows: labels fold through the container breakpoints, then whole controls move down. -->
      <div class="relative flex flex-wrap items-center gap-1 px-2 pb-2 pt-1.5">
        <button
          type="button"
          class="d-press flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-(--d-border2) py-0 ps-0.75 pe-2.5 text-xs font-medium transition-colors duration-200 hover:bg-(--d-hover) @max-[28.75rem]:pe-0.75"
          :class="currentModeConfig.color"
          :title="t('composer.modeCycle', { mode: currentModeConfig.label })"
          :aria-label="t('composer.modeCycle', { mode: currentModeConfig.label })"
          data-testid="composer-mode"
          @click="cycleMode"
        >
          <span
            class="relative flex"
            aria-hidden="true"
          >
            <span
              class="absolute inset-y-0 inset-s-0 w-5 rounded-full bg-current/15 transition-transform duration-300 ease-(--ease-spring)"
              :style="{ transform: `translateX(${modeIndex * 100}%)` }"
            />
            <span
              v-for="mode in modeOrder"
              :key="mode"
              class="relative flex size-5 items-center justify-center transition-opacity duration-200"
              :class="mode === permissionMode ? 'opacity-100' : 'opacity-40'"
            >
              <component
                :is="modeConfig[mode].icon"
                class="size-3"
              />
            </span>
          </span>
          <Transition
            name="t-fade"
            mode="out-in"
          >
            <span
              :key="permissionMode"
              class="whitespace-nowrap @max-[28.75rem]:hidden"
            >{{ currentModeConfig.label }}</span>
          </Transition>
        </button>

        <button
          type="button"
          class="d-press flex h-7 shrink-0 items-center gap-1.25 rounded-full px-2.25 text-xs font-medium transition-colors duration-200"
          :class="dangerouslySkipPermissions
            ? 'bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] text-(--d-danger-text)'
            : 'text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)'"
          :aria-pressed="dangerouslySkipPermissions"
          :title="t('chatInput.yolo.tooltip')"
          data-testid="composer-yolo"
          @click="toggleDangerouslySkipPermissions"
        >
          <LockOpen
            class="size-3"
            aria-hidden="true"
          />
          <span class="@max-[25rem]:sr-only">{{ dangerouslySkipPermissions ? t("chatInput.yolo.active") : t("chatInput.yolo.inactive") }}</span>
        </button>

        <button
          v-if="settingsStore.hostCapabilities.ideContext"
          type="button"
          class="flex h-7 min-w-0 items-center gap-1.25 rounded-full px-2.25 text-xs transition-colors hover:bg-(--d-hover)"
          :class="ideContextEnabled ? 'text-(--d-text)' : 'text-(--d-faint) hover:text-(--d-faint-text)'"
          :aria-pressed="ideContextEnabled"
          :title="ideContextTooltip"
          data-testid="composer-ide"
          @click="toggleIdeContext"
        >
          <component
            :is="uiStore.ideContext?.type === 'selection' ? Eye : Code"
            class="size-3 shrink-0"
            aria-hidden="true"
          />
          <span
            class="truncate font-mono text-11.5 @max-[25rem]:hidden"
            :class="{ 'line-through': !ideContextEnabled && uiStore.ideContext }"
          >{{ ideContextLabel }}</span>
        </button>

        <button
          type="button"
          class="d-tool-btn size-7 min-w-7 rounded-full px-0"
          :title="t('composer.attachImage')"
          :aria-label="t('composer.attachImage')"
          data-testid="composer-attach"
          @click="fileInputRef?.click()"
        >
          <Paperclip
            class="size-3.5"
            aria-hidden="true"
          />
        </button>
        <input
          ref="fileInputRef"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          class="hidden"
          tabindex="-1"
          aria-hidden="true"
          @change="attachChosenImages"
        >

        <div class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          <Transition name="t-fade">
            <span
              v-if="isProcessing && canSend"
              class="me-1 min-w-0 truncate text-11 text-(--d-warning)"
              data-testid="composer-will-queue"
            >
              {{ t("chatInput.willQueue") }}
            </span>
          </Transition>

          <ModelEffortPopover />

          <button
            v-if="settingsStore.voiceControlsAvailable && (!isProcessing || isWakeMode)"
            type="button"
            class="d-tool-btn size-7.5 min-w-7.5 rounded-9 px-0"
            :class="micButtonClass"
            :disabled="voiceMicDisabled"
            :title="voiceTooltip"
            :aria-label="voiceTooltip"
            data-testid="composer-voice"
            @click="handleVoiceToggle"
          >
            <LoaderCircle
              v-if="micShowsSpinner"
              class="size-3.75 animate-[d-spin_.9s_linear_infinite]"
              aria-hidden="true"
            />
            <Mic
              v-else
              class="size-3.75"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            class="d-press flex size-8 shrink-0 items-center justify-center rounded-10 transition-colors duration-200"
            :class="isProcessing && !canSend
              ? 'bg-(--d-danger) text-(--d-on-danger)'
              : canSend
                ? 'bg-(--d-accent) text-(--d-on-accent) shadow-[0_4px_14px_var(--d-accent-soft)]'
                : 'bg-(--d-hover) text-(--d-faint)'"
            :disabled="canSend ? settingsStore.workspaceFolderSwitchPending : !isProcessing"
            :title="isProcessing && !canSend ? t('composer.stop') : t('composer.send')"
            :aria-label="isProcessing && !canSend ? t('composer.stop') : t('composer.send')"
            data-testid="composer-send"
            @click="handleButtonClick"
          >
            <span
              v-if="isProcessing && !canSend"
              class="size-2.75 rounded-[0.1875rem] bg-current"
              aria-hidden="true"
            />
            <ArrowUp
              v-else
              class="size-4"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
