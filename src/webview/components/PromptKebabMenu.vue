<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { MoreVertical } from "lucide-vue-next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";

interface Props {
  prompt: EnrichedPrompt;
  canRewind: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  copy: [];
  editAndResend: [text: string];
  rewind: [messageId: string];
}>();

const { t } = useI18n();

const open = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

function clearCopiedTimer(): void {
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
}

onBeforeUnmount(() => {
  clearCopiedTimer();
});

async function handleCopy(): Promise<void> {
  const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!writeText) {
    open.value = false;
    return;
  }
  try {
    await writeText(props.prompt.text);
  } catch {
    open.value = false;
    return;
  }
  emit("copy");
  clearCopiedTimer();
  copied.value = true;
  copiedTimer = setTimeout(() => {
    copied.value = false;
    copiedTimer = null;
    open.value = false;
  }, 1000);
}

function handleEditAndResend(): void {
  emit("editAndResend", props.prompt.text);
  open.value = false;
}

function handleRewind(): void {
  if (!props.canRewind) return;
  emit("rewind", props.prompt.messageId);
  open.value = false;
}

function stopRowClick(event: MouseEvent): void {
  event.stopPropagation();
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity inline-flex items-center justify-center w-6 h-6 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
        :aria-label="t('promptNavigator.kebab.menuLabel')"
        @click.stop="stopRowClick"
      >
        <MoreVertical class="w-3.5 h-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :side-offset="4"
      class="w-48 p-1"
      role="menu"
      @click.stop
    >
      <button
        type="button"
        role="menuitem"
        class="flex items-center w-full px-2 py-1.5 text-xs text-foreground rounded hover:bg-accent text-left cursor-pointer"
        @click="handleCopy"
      >
        {{ copied ? t("promptNavigator.kebab.copied") : t("promptNavigator.kebab.copy") }}
      </button>
      <button
        type="button"
        role="menuitem"
        class="flex items-center w-full px-2 py-1.5 text-xs text-foreground rounded hover:bg-accent text-left cursor-pointer"
        :title="t('promptNavigator.kebab.editTooltip')"
        @click="handleEditAndResend"
      >
        {{ t("promptNavigator.kebab.editAndResend") }}
      </button>
      <hr class="my-1 border-border" />
      <button
        type="button"
        role="menuitem"
        :class="[
          'flex items-center w-full px-2 py-1.5 text-xs rounded text-left text-destructive',
          canRewind ? 'hover:bg-accent cursor-pointer' : 'opacity-50 pointer-events-none cursor-not-allowed',
        ]"
        :title="canRewind ? undefined : t('promptNavigator.kebab.rewindDisabledTooltip')"
        :aria-disabled="!canRewind"
        @click="handleRewind"
      >
        {{ t("promptNavigator.kebab.rewind") }}
      </button>
    </PopoverContent>
  </Popover>
</template>
