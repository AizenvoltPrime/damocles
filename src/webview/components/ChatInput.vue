<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Component } from "vue";
import { useI18n } from "vue-i18n";
import type { PermissionMode } from "@shared/types/settings";
import type { UserContentBlock } from "@shared/types/content";
import { Button } from "@/components/ui/button";
import { IconPencil, IconCheck, IconLockOpen, IconClipboard, IconPlay, IconEye, IconCode, IconMicrophone, IconLoader, IconBolt } from "@/components/icons";
import { usePromptHistory } from "@/composables/usePromptHistory";
import { useAtMentionAutocomplete } from "@/composables/useAtMentionAutocomplete";
import { useSlashCommandAutocomplete } from "@/composables/useSlashCommandAutocomplete";
import { useImageAttachments } from "@/composables/useImageAttachments";
import { useVoiceInput } from "@/composables/useVoiceInput";
import { useUIStore } from "@/stores/useUIStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import AtMentionPopup from "./AtMentionPopup.vue";
import SlashCommandPopup from "./SlashCommandPopup.vue";
import ImageThumbnailStrip from "./ImageThumbnailStrip.vue";

const { t } = useI18n();
const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const MAX_TEXTAREA_HEIGHT = 200;

const props = defineProps<{
  isProcessing: boolean;
  permissionMode: PermissionMode;
  dangerouslySkipPermissions: boolean;
  settingsOpen?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string | UserContentBlock[], includeIdeContext: boolean];
  queue: [content: string | UserContentBlock[]];
  cancel: [];
  changeMode: [mode: PermissionMode];
  toggleDangerouslySkipPermissions: [];
  toggleFastMode: [];
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
  checkAndUpdateSlashCommand,
  handleKeyDown: handleSlashCommandKeyDown,
  selectItem: selectSlashCommandItem,
  close: closeSlashCommand,
} = useSlashCommandAutocomplete(inputText, textareaRef);

const {
  attachments: imageAttachments,
  hasAttachments: hasImageAttachments,
  addFromClipboard: addImageFromClipboard,
  remove: removeImage,
  clear: clearImages,
  toContentBlocks: imagesToContentBlocks,
} = useImageAttachments();

const {
  status: voiceStatus,
  startRecording,
  setRecording: voiceSetRecording,
  stopRecording,
  cancelRecording,
  setDone: voiceSetDone,
  setError: voiceSetError,
} = useVoiceInput();

function handleVoiceToggle() {
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
    adjustTextareaHeight();
    textareaRef.value?.focus();
  });
}

const voiceTooltip = computed(() => {
  if (!settingsStore.voiceHasApiKey) return t("chatInput.voice.noApiKey");
  if (voiceStatus.value === "starting") return t("chatInput.voice.starting");
  if (voiceStatus.value === "recording") return t("chatInput.voice.stopRecording");
  if (voiceStatus.value === "transcribing") return t("chatInput.voice.transcribing");
  return t("chatInput.voice.startRecording");
});

function adjustTextareaHeight() {
  const textarea = textareaRef.value;
  if (!textarea) return;

  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

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

watch(inputText, () => {
  nextTick(adjustTextareaHeight);
});

function focus() {
  textareaRef.value?.focus();
}

function setInput(value: string) {
  inputText.value = value;
  nextTick(() => {
    adjustTextareaHeight();
    textareaRef.value?.focus();
  });
}

defineExpose({ focus, setInput, appendTranscription, voiceSetRecording, voiceSetDone, voiceSetError });

const canSend = computed(() => inputText.value.trim().length > 0 || hasImageAttachments.value);

const modeConfig = computed<Record<PermissionMode, { icon: Component; label: string; shortLabel: string }>>(() => ({
  default: { icon: IconPencil, label: t("chatInput.permissionModes.default.label"), shortLabel: t("chatInput.permissionModes.default.short") },
  acceptEdits: {
    icon: IconCheck,
    label: t("chatInput.permissionModes.acceptEdits.label"),
    shortLabel: t("chatInput.permissionModes.acceptEdits.short"),
  },
  plan: { icon: IconClipboard, label: t("chatInput.permissionModes.plan.label"), shortLabel: t("chatInput.permissionModes.plan.short") },
}));

const modeOrder: PermissionMode[] = ["default", "acceptEdits", "plan"];

const currentModeConfig = computed(() => modeConfig.value[props.permissionMode]);

function cycleMode() {
  const currentIndex = modeOrder.indexOf(props.permissionMode);
  const nextIndex = (currentIndex + 1) % modeOrder.length;
  emit("changeMode", modeOrder[nextIndex]);
}

function toggleDangerouslySkipPermissions() {
  emit("toggleDangerouslySkipPermissions");
}

function toggleFastMode() {
  emit("toggleFastMode");
}

const currentModelSupportsFastMode = computed(() => {
  const model = settingsStore.availableModels.find(m => m.value === settingsStore.activeModel);
  return model?.supportsFastMode ?? false;
});

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

function handleSend() {
  if (!canSend.value) return;
  const text = inputText.value.trim();
  addEntry(text);

  const imageBlocks = imagesToContentBlocks();
  const content: string | UserContentBlock[] = imageBlocks.length > 0 ? [...imageBlocks, ...(text ? [{ type: "text" as const, text }] : [])] : text;

  if (props.isProcessing) {
    emit("queue", content);
  } else {
    emit("send", content, ideContextEnabled.value);
  }

  inputText.value = "";
  clearImages();
  resetHistory();
}

function handleButtonClick() {
  if (canSend.value) {
    handleSend();
  } else if (props.isProcessing) {
    handleCancel();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Tab" && event.shiftKey) {
    event.preventDefault();
    if (!props.isProcessing) {
      cycleMode();
    }
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
  if ((event.target as HTMLElement)?.closest('[role="dialog"]')) {
    return;
  }
  event.preventDefault();
  handleCancel();
}

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeydown);
  adjustTextareaHeight();
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>

<template>
  <div class="shrink-0 bg-card">
    <!-- @ Mention Autocomplete Popup -->
    <AtMentionPopup
      :is-open="atMentionOpen"
      :items="atMentionItems"
      v-model:selected-index="atMentionSelectedIndex"
      :anchor-element="cardRef"
      :query="atMentionQuery"
      :is-loading="atMentionLoading"
      @select="selectAtMentionItem(atMentionItems.indexOf($event))"
      @close="closeAtMention"
    />

    <!-- Slash Command Autocomplete Popup -->
    <SlashCommandPopup
      :is-open="slashCommandOpen"
      :commands="slashCommandCommands"
      v-model:selected-index="slashCommandSelectedIndex"
      :anchor-element="cardRef"
      :query="slashCommandQuery"
      :is-loading="slashCommandLoading"
      @select="selectSlashCommandItem(slashCommandCommands.indexOf($event))"
      @close="closeSlashCommand"
    />

    <!-- Input area -->
    <div class="p-3">
      <div ref="cardRef" class="bg-input rounded-lg border border-border overflow-hidden transition-colors focus-within:border-primary">
        <textarea
          ref="textareaRef"
          v-model="inputText"
          :placeholder="isProcessing ? t('chatInput.placeholderQueued') : t('chatInput.placeholder')"
          rows="1"
          class="w-full p-3 bg-transparent text-foreground resize-none overflow-hidden focus:outline-none placeholder:text-muted-foreground"
          :style="{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }"
          @keydown="handleKeydown"
          @input="handleInput"
          @paste="handlePaste"
        />

        <!-- Image attachments strip -->
        <ImageThumbnailStrip :attachments="imageAttachments" @remove="removeImage" />

        <!-- Bottom bar inside input -->
        <div class="flex items-center justify-between px-3 py-2 border-t border-border/50 bg-foreground/5">
          <div class="flex items-center gap-3">
            <!-- Mode toggle button -->
            <Button
              variant="ghost"
              size="sm"
              class="h-auto px-2 py-1 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5"
              :disabled="isProcessing"
              @click="cycleMode"
              :title="`${currentModeConfig.label} (Shift+Tab to cycle)`"
            >
              <component :is="currentModeConfig.icon" :size="12" />
              <span>{{ currentModeConfig.label }}</span>
            </Button>

            <!-- YOLO mode toggle -->
            <Button
              variant="ghost"
              size="sm"
              class="h-auto px-2 py-1 text-xs flex items-center gap-1.5"
              :class="
                dangerouslySkipPermissions
                  ? 'text-destructive hover:text-destructive/80 bg-destructive/10'
                  : 'text-muted-foreground hover:text-foreground'
              "
              :disabled="isProcessing"
              @click="toggleDangerouslySkipPermissions"
              :title="t('chatInput.yolo.tooltip')"
            >
              <IconLockOpen :size="12" />
              <span>{{ dangerouslySkipPermissions ? t("chatInput.yolo.active") : t("chatInput.yolo.inactive") }}</span>
            </Button>

            <!-- Fast mode toggle -->
            <Button
              v-if="currentModelSupportsFastMode"
              variant="ghost"
              size="sm"
              class="h-auto px-2 py-1 text-xs flex items-center gap-1.5"
              :class="
                settingsStore.fastModeState === 'cooldown'
                  ? 'text-orange-500 animate-pulse bg-orange-500/10'
                  : settingsStore.currentSettings.fastMode
                    ? 'text-amber-500 bg-amber-500/10'
                    : 'text-muted-foreground hover:text-foreground'
              "
              :disabled="isProcessing"
              @click="toggleFastMode"
              :title="t('chatInput.fast.tooltip')"
            >
              <IconBolt :size="12" />
              <span>{{ t('chatInput.fast.label') }}</span>
            </Button>

            <!-- IDE Context toggle -->
            <button
              class="flex items-center gap-1.5 text-xs transition-colors cursor-pointer"
              :class="ideContextEnabled ? 'text-foreground' : 'text-muted-foreground/50'"
              @click="toggleIdeContext"
              :title="ideContextTooltip"
            >
              <component
                :is="uiStore.ideContext?.type === 'selection' ? IconEye : IconCode"
                :size="12"
                :class="ideContextEnabled ? '' : 'opacity-50'"
              />
              <span :class="!ideContextEnabled && uiStore.ideContext ? 'line-through' : ''">
                {{ ideContextLabel }}
              </span>
            </button>
          </div>

          <div class="flex items-center gap-3">
            <!-- Queue indicator when processing and has input -->
            <span v-if="isProcessing && canSend" class="text-xs text-foreground">
              {{ t("chatInput.willQueue") }}
            </span>

            <!-- Voice input button -->
            <Button
              v-if="!isProcessing"
              variant="ghost"
              size="icon"
              class="w-8 h-8 rounded-lg transition-all [&_svg]:size-[1.125rem]"
              :class="{
                'text-destructive ring-2 ring-destructive/50 bg-destructive/10 animate-pulse': voiceStatus === 'recording',
                'text-muted-foreground hover:text-foreground': voiceStatus === 'idle',
                'text-orange-500': voiceStatus === 'error',
              }"
              :disabled="!settingsStore.voiceHasApiKey || voiceStatus === 'transcribing' || voiceStatus === 'starting'"
              :title="voiceTooltip"
              @click="handleVoiceToggle"
            >
              <IconLoader v-if="voiceStatus === 'transcribing' || voiceStatus === 'starting'" :size="18" class="animate-spin" />
              <IconMicrophone v-else :size="18" />
            </Button>

            <!-- Send/Stop button -->
            <Button
              :disabled="!canSend && !isProcessing"
              size="icon"
              class="w-8 h-8 rounded-lg"
              :class="isProcessing && !canSend ? 'bg-destructive hover:bg-destructive/80 border-destructive' : ''"
              @click="handleButtonClick"
            >
              <span v-if="isProcessing && !canSend" class="w-3.5 h-3.5 bg-destructive-foreground rounded" />
              <IconPlay v-else :size="14" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
