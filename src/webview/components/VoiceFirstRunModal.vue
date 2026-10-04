<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Mic } from "lucide-vue-next";
import OverlayShell from "./OverlayShell.vue";

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

const privacyPoints = computed<string[]>(() => [
  t("voiceFirstRun.privacyAlwaysOn"),
  t("voiceFirstRun.privacyLocal"),
  t("voiceFirstRun.privacyWakePhrase"),
  t("voiceFirstRun.privacyAutoDisable"),
]);

interface EngineRow {
  role: string;
  name: string;
  license: string;
}

const engines = computed<EngineRow[]>(() => [
  { role: t("voiceFirstRun.roleWake"), name: "OpenWakeWord", license: "Apache-2.0" },
  { role: t("voiceFirstRun.roleVad"), name: "Silero", license: "MIT" },
  { role: t("voiceFirstRun.roleAsr"), name: "Parakeet TDT 0.6B v2", license: "CC-BY-4.0" },
  { role: t("voiceFirstRun.roleTts"), name: "VibeVoice-Realtime 0.5B", license: t("voiceFirstRun.ttsLicense") },
]);

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
      <section class="flex flex-col gap-2">
        <h3 class="text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">
          {{ t("voiceFirstRun.whatThisEnables") }}
        </h3>
        <ul class="flex flex-col gap-1.5 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5 text-12.5">
          <li
            v-for="(point, i) in privacyPoints"
            :key="i"
            class="flex gap-2 text-pretty"
          >
            <span
              class="mt-2 size-1.25 flex-none rounded-full bg-(--d-accent)"
              aria-hidden="true"
            />
            <span>{{ point }}</span>
          </li>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">
          {{ t("voiceFirstRun.engines") }}
        </h3>
        <dl class="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5 text-12.5">
          <template
            v-for="engine in engines"
            :key="engine.role"
          >
            <dt class="text-(--d-faint)">
              {{ engine.role }}
            </dt>
            <dd class="min-w-0">
              <span class="font-medium">{{ engine.name }}</span>
              <span class="ml-2 rounded-5 bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)">{{ engine.license }}</span>
            </dd>
          </template>
        </dl>
      </section>
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
