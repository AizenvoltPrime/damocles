<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import { useVSCode } from "@/composables/useVSCode";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IconChevronDown } from "@/components/icons";
import { useI18n } from "vue-i18n";
import {
  DEFAULT_END_OF_TURN_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_WAKE_SENSITIVITY,
  type TtsVoiceId,
} from "@shared/types/voice";
import {
  buildSensitivityMessage,
  buildEndOfTurnMessage,
  buildMaxUtteranceMessage,
  buildGpuMessage,
  formatVoiceFilesBytes,
} from "./jarvis-settings-logic";

const { t } = useI18n();

const settingsStore = useSettingsStore();
const { voiceConfig } = storeToRefs(settingsStore);

const jarvisStore = useVoiceJarvisStore();
const { voiceFilesBytes } = storeToRefs(jarvisStore);

const { postMessage } = useVSCode();

const gpuOptions = computed<{ value: "auto" | "cuda" | "cpu"; label: string }[]>(() => [
  { value: "auto", label: t("jarvisSettings.gpuAuto") },
  { value: "cuda", label: t("jarvisSettings.gpuCuda") },
  { value: "cpu", label: t("jarvisSettings.gpuCpu") },
]);

const voiceOptions = computed<{ value: TtsVoiceId; label: string }[]>(() => [
  { value: "en-Carter_man", label: t("jarvisSettings.voiceCarter") },
  { value: "en-Davis_man", label: t("jarvisSettings.voiceDavis") },
  { value: "en-Emma_woman", label: t("jarvisSettings.voiceEmma") },
  { value: "en-Frank_man", label: t("jarvisSettings.voiceFrank") },
  { value: "en-Grace_woman", label: t("jarvisSettings.voiceGrace") },
  { value: "en-Mike_man", label: t("jarvisSettings.voiceMike") },
]);

const removeFilesConfirmOpen = ref<boolean>(false);
const advancedOpen = ref<boolean>(false);

// Local mirrors so the slider thumb tracks the user's drag in real time.
// Reading Pinia directly lags behind during drag because each setter
// posts a message that round-trips through the extension before voiceConfig
// updates — that lag manifests as visible thumb jitter. The watchers below
// reconcile the local value when an *external* change lands (settings edit,
// remote update) without fighting an in-progress drag.
const localSensitivity = ref<number>(voiceConfig.value.wakeWordSensitivity ?? DEFAULT_WAKE_SENSITIVITY);
const localEndOfTurn = ref<number>(voiceConfig.value.endOfTurnSilenceMs ?? DEFAULT_END_OF_TURN_MS);
const localMaxUtterance = ref<number>(voiceConfig.value.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS);

watch(() => voiceConfig.value.wakeWordSensitivity, (val) => {
  if (val !== undefined && val !== localSensitivity.value) localSensitivity.value = val;
});
watch(() => voiceConfig.value.endOfTurnSilenceMs, (val) => {
  if (val !== undefined && val !== localEndOfTurn.value) localEndOfTurn.value = val;
});
watch(() => voiceConfig.value.maxUtteranceMs, (val) => {
  if (val !== undefined && val !== localMaxUtterance.value) localMaxUtterance.value = val;
});

const sensitivityModel = computed<number[]>({
  get: () => [localSensitivity.value],
  set: (v) => {
    const value = v[0] ?? 0.5;
    localSensitivity.value = value;
    postMessage(buildSensitivityMessage(value));
  },
});

const endOfTurnModel = computed<number[]>({
  get: () => [localEndOfTurn.value],
  set: (v) => {
    const value = v[0] ?? 800;
    localEndOfTurn.value = value;
    postMessage(buildEndOfTurnMessage(value));
  },
});

const maxUtteranceModel = computed<number[]>({
  get: () => [localMaxUtterance.value],
  set: (v) => {
    const value = v[0] ?? 30000;
    localMaxUtterance.value = value;
    postMessage(buildMaxUtteranceMessage(value));
  },
});

const wakeModeEnabled = computed<boolean>(() => voiceConfig.value.mode === "wake-word");

function handleTtsToggle(enabled: boolean): void {
  postMessage({ type: "setVoiceTtsEnabled", enabled });
}

function handleTtsVoiceChange(value: string): void {
  postMessage({ type: "setVoiceTtsVoice", voice: value as TtsVoiceId });
}

function handleTestVoice(): void {
  postMessage({ type: "voiceTestVoice" });
}

function handleGpuChange(value: string): void {
  postMessage(buildGpuMessage(value as "auto" | "cuda" | "cpu"));
}

function handleAutoSubmitToggle(autoSubmit: boolean): void {
  postMessage({ type: "setVoiceAutoSubmit", autoSubmit });
}

function handleDiagnosticsToggle(diagnostics: boolean): void {
  postMessage({ type: "setVoiceDiagnostics", diagnostics });
}

function handleRedownload(): void {
  postMessage({ type: "voiceRedownloadModels" });
}

function handleOpenModelsFolder(): void {
  postMessage({ type: "voiceOpenModelsFolder" });
}

function handleFreeDiskSpace(): void {
  postMessage({ type: "voiceFreeDiskSpace" });
}

function openRemoveAllConfirm(): void {
  removeFilesConfirmOpen.value = true;
}

function confirmRemoveAll(): void {
  postMessage({ type: "voiceRemoveAllFiles" });
  removeFilesConfirmOpen.value = false;
}

function cancelRemoveAll(): void {
  removeFilesConfirmOpen.value = false;
}

const removeAllLabel = computed<string>(() => {
  const formatted = formatVoiceFilesBytes(voiceFilesBytes.value);
  return formatted === null
    ? t("jarvisSettings.removeAll")
    : t("jarvisSettings.removeAllWithSize", { size: formatted });
});

onMounted(() => {
  // Ask the extension for the current on-disk voice-files size so the
  // "Remove all voice files (X GB)" label reflects reality. Without this
  // ping the value stayed at the store default of 0 forever.
  postMessage({ type: "voiceQueryFilesSize" });
});

const sensitivityLabel = computed<string>(() => sensitivityModel.value[0]?.toFixed(2) ?? "0.50");

const endOfTurnLabel = computed<string>(() => `${endOfTurnModel.value[0] ?? 800} ms`);

const maxUtteranceLabel = computed<string>(() => {
  const ms = maxUtteranceModel.value[0] ?? 30000;
  return `${(ms / 1000).toFixed(1)} s`;
});
</script>

<template>
  <section class="space-y-5">
    <div v-if="wakeModeEnabled">
      <div class="flex items-baseline justify-between mb-1">
        <Label class="text-xs text-muted-foreground">{{ t("jarvisSettings.sensitivityLabel") }}</Label>
        <span class="text-xs text-muted-foreground tabular-nums">{{ sensitivityLabel }}</span>
      </div>
      <Slider
        v-model="sensitivityModel"
        :min="0.1"
        :max="0.95"
        :step="0.01"
      />
      <p class="text-xs text-muted-foreground mt-1">
        {{ t("jarvisSettings.sensitivityHint") }}
      </p>
    </div>

    <div class="border-t border-border/30 pt-4 space-y-3">
      <h4 class="text-sm font-medium text-foreground">{{ t("jarvisSettings.spokenRepliesTitle") }}</h4>

      <div class="flex items-center justify-between">
        <Label for="jarvis-tts-toggle" class="text-sm font-normal">
          {{ t("jarvisSettings.speakAssistantReplies") }}
        </Label>
        <Switch
          id="jarvis-tts-toggle"
          :checked="voiceConfig.ttsEnabled ?? false"
          @update:checked="handleTtsToggle"
        />
      </div>

      <div>
        <Label class="text-xs text-muted-foreground mb-1 block">{{ t("jarvisSettings.voicePicker") }}</Label>
        <Select
          :model-value="voiceConfig.ttsVoice ?? 'en-Carter_man'"
          :disabled="!voiceConfig.ttsEnabled"
          @update:model-value="handleTtsVoiceChange"
        >
          <SelectTrigger class="w-full bg-input border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent class="bg-popover border-border">
            <SelectItem v-for="opt in voiceOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        variant="outline"
        size="sm"
        :disabled="!voiceConfig.ttsEnabled"
        @click="handleTestVoice"
      >
        {{ t("jarvisSettings.testVoice") }}
      </Button>
    </div>

    <div class="border-t border-border/30 pt-4 space-y-4">
      <div>
        <Label class="text-xs text-muted-foreground mb-1 block">{{ t("jarvisSettings.gpuPreference") }}</Label>
        <Select
          :model-value="voiceConfig.localGpu ?? 'auto'"
          @update:model-value="handleGpuChange"
        >
          <SelectTrigger class="w-full bg-input border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent class="bg-popover border-border">
            <SelectItem v-for="opt in gpuOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center justify-between">
        <Label for="jarvis-auto-submit" class="text-sm font-normal">{{ t("jarvisSettings.autoSubmit") }}</Label>
        <Switch
          id="jarvis-auto-submit"
          :checked="voiceConfig.autoSubmit ?? true"
          @update:checked="handleAutoSubmitToggle"
        />
      </div>

      <Collapsible v-model:open="advancedOpen">
        <CollapsibleTrigger
          class="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors py-1 cursor-pointer"
        >
          <span>{{ t("jarvisSettings.advanced") }}</span>
          <IconChevronDown
            :size="12"
            class="transition-transform"
            :class="{ 'rotate-180': advancedOpen }"
          />
        </CollapsibleTrigger>
        <CollapsibleContent class="space-y-4 pt-2">
          <div>
            <div class="flex items-baseline justify-between mb-1">
              <Label class="text-xs text-muted-foreground">{{ t("jarvisSettings.endOfTurn") }}</Label>
              <span class="text-xs text-muted-foreground tabular-nums">{{ endOfTurnLabel }}</span>
            </div>
            <Slider
              v-model="endOfTurnModel"
              :min="300"
              :max="3000"
              :step="50"
            />
          </div>

          <div>
            <div class="flex items-baseline justify-between mb-1">
              <Label class="text-xs text-muted-foreground">{{ t("jarvisSettings.maxUtterance") }}</Label>
              <span class="text-xs text-muted-foreground tabular-nums">{{ maxUtteranceLabel }}</span>
            </div>
            <Slider
              v-model="maxUtteranceModel"
              :min="5000"
              :max="120000"
              :step="1000"
            />
          </div>

          <div class="flex items-center justify-between">
            <Label for="jarvis-diagnostics" class="text-sm font-normal">{{ t("jarvisSettings.diagnostics") }}</Label>
            <Switch
              id="jarvis-diagnostics"
              :checked="voiceConfig.diagnostics ?? false"
              @update:checked="handleDiagnosticsToggle"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>

    <div class="border-t border-border/30 pt-4 space-y-2">
      <h4 class="text-sm font-medium text-foreground">{{ t("jarvisSettings.maintenanceTitle") }}</h4>

      <Button
        variant="outline"
        size="sm"
        class="w-full"
        @click="handleRedownload"
      >
        {{ t("jarvisSettings.redownload") }}
      </Button>

      <Button
        variant="outline"
        size="sm"
        class="w-full"
        @click="handleOpenModelsFolder"
      >
        {{ t("jarvisSettings.openFolder") }}
      </Button>

      <Button
        variant="outline"
        size="sm"
        class="w-full"
        @click="handleFreeDiskSpace"
      >
        {{ t("jarvisSettings.freeDiskSpace") }}
      </Button>

      <Button
        variant="destructive"
        size="sm"
        class="w-full"
        @click="openRemoveAllConfirm"
      >
        {{ removeAllLabel }}
      </Button>
    </div>

    <AlertDialog v-model:open="removeFilesConfirmOpen">
      <AlertDialogContent class="bg-card border-border">
        <AlertDialogHeader>
          <AlertDialogTitle class="text-foreground">{{ t("jarvisSettings.confirmRemoveTitle") }}</AlertDialogTitle>
          <AlertDialogDescription class="text-muted-foreground">
            {{ t("jarvisSettings.confirmRemoveDescription") }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel @click="cancelRemoveAll">{{ t("jarvisSettings.cancel") }}</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmRemoveAll"
          >
            {{ t("jarvisSettings.confirmRemoveAction") }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
