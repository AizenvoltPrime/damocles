<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Mic } from "lucide-vue-next";
import OverlayShell from "./OverlayShell.vue";
import VoiceDisclosure from "./VoiceDisclosure.vue";

type FirstRunReason = "missing-runtime" | "missing-models" | "first-time";

const props = defineProps<{
  reason: FirstRunReason;
}>();

const emit = defineEmits<{
  (e: "accept"): void;
  (e: "cancel"): void;
}>();

const { t } = useI18n();

const sizeNote = computed<string>(() => {
  if (props.reason === "missing-runtime") return t("voiceFirstRun.sizeRuntime");
  if (props.reason === "missing-models") return t("voiceFirstRun.sizeModels");
  return t("voiceFirstRun.sizeFirstTime");
});

function handleAccept(): void {
  emit("accept");
}

function handleCancel(): void {
  emit("cancel");
}
</script>

<template>
  <OverlayShell
    :title="t('voiceFirstRun.title')"
    :subtitle="t('voiceFirstRun.subtitle')"
    :icon="Mic"
    max-width="40rem"
    data-testid="voice-first-run"
    @close="handleCancel"
  >
    <div class="flex flex-col gap-4 px-4.5 pt-4 pb-5">
      <VoiceDisclosure />
    </div>

    <template #footer>
      <footer class="flex flex-none items-center gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <span
          class="flex-1 text-11.5 text-pretty text-(--d-faint)"
          role="note"
        >{{ sizeNote }}</span>
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
          @click="handleCancel"
        >
          {{ t("voiceFirstRun.cancel") }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
          @click="handleAccept"
        >
          <Download
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t("voiceFirstRun.accept") }}
        </button>
      </footer>
    </template>
  </OverlayShell>
</template>
