<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

// What the user consents to before any voice download: the first-run dialog in a chat and Settings > Voice show this.
const { t } = useI18n();

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
  { role: t("voiceFirstRun.roleWake"), name: "sherpa-onnx keyword spotting", license: "Apache-2.0" },
  { role: t("voiceFirstRun.roleVad"), name: "Silero", license: "MIT" },
  { role: t("voiceFirstRun.roleAsr"), name: "Parakeet TDT 0.6B v2", license: "CC-BY-4.0" },
  { role: t("voiceFirstRun.roleTts"), name: "VibeVoice-Realtime 0.5B", license: t("voiceFirstRun.ttsLicense") },
]);
</script>

<template>
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
</template>
