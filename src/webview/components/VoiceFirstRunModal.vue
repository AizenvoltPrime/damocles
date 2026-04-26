<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconMicrophone } from "@/components/icons";
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
    :icon="IconMicrophone"
    icon-class="text-primary"
    @close="handleCancel"
  >
    <div class="p-6 max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-base">{{ t("voiceFirstRun.whatThisEnables") }}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-2 text-sm leading-relaxed">
            <li
              v-for="(point, i) in privacyPoints"
              :key="i"
              class="flex gap-2"
            >
              <span class="text-primary shrink-0" aria-hidden="true">•</span>
              <span class="text-foreground">{{ point }}</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-base">{{ t("voiceFirstRun.engines") }}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-1.5 text-sm">
            <li
              v-for="engine in engines"
              :key="engine.role"
              class="flex items-baseline gap-2"
            >
              <span class="text-muted-foreground w-20 shrink-0">{{ engine.role }}:</span>
              <span class="text-foreground font-medium">{{ engine.name }}</span>
              <span class="text-xs text-muted-foreground">({{ engine.license }})</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="pt-4">
          <p class="text-sm text-foreground" role="note">
            {{ sizeNote }}
          </p>
        </CardContent>
      </Card>

      <div class="flex justify-end gap-2 pt-2">
        <Button
          variant="outline"
          @click="handleCancel"
        >
          {{ t("voiceFirstRun.cancel") }}
        </Button>
        <Button
          variant="default"
          @click="handleAccept"
        >
          {{ t("voiceFirstRun.accept") }}
        </Button>
      </div>
    </div>
  </OverlayShell>
</template>
