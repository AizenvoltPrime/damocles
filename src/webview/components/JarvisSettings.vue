<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import {
  DEFAULT_END_OF_TURN_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_TTS_VOICE,
  DEFAULT_WAKE_SENSITIVITY,
  type GpuPreference,
  type TtsVoiceId,
  type VoiceConfig,
} from "@shared/types/voice";
import type { WebviewToExtensionMessage } from "@shared/types/messages";
import { Trash2 } from "lucide-vue-next";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { useOpenerFocus } from "@/composables/useOpenerFocus";
import ConfirmDialogLayout from "./ConfirmDialogLayout.vue";
import SettingsRow from "./settings/SettingsRow.vue";
import SettingSwitch from "./settings/controls/SettingSwitch.vue";
import SettingSelect from "./settings/controls/SettingSelect.vue";
import SettingSeg from "./settings/controls/SettingSeg.vue";
import SettingSlider from "./settings/controls/SettingSlider.vue";
import SettingButton from "./settings/controls/SettingButton.vue";
import { useSettingWrite } from "./settings/settings-writes";
import { useSettingsPage } from "./settings/settings-view";
import {
  buildSensitivityMessage,
  buildEndOfTurnMessage,
  buildMaxUtteranceMessage,
  buildGpuMessage,
  formatVoiceFilesBytes,
} from "./jarvis-settings-logic";

const { t } = useI18n();
const page = useSettingsPage();
const settingsStore = useSettingsStore();
const { voiceConfig } = storeToRefs(settingsStore);
const { voiceFilesBytes } = storeToRefs(useVoiceJarvisStore());
const { postMessage } = usePlatformBridge();
const write = useSettingWrite();

const gpuOptions = computed<{ value: GpuPreference; label: string }[]>(() => [
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

const wakeMode = computed(() => voiceConfig.value.mode === "wake-word");

function update(key: string, message: WebviewToExtensionMessage, patch: Partial<VoiceConfig>): void {
  // The revert puts back only the patched fields, so it never undoes another voice row's write.
  const undo: Partial<VoiceConfig> = Object.fromEntries(Object.keys(patch).map((field) => [field, voiceConfig.value[field as keyof VoiceConfig]]));
  write(key, message, {
    apply: () => settingsStore.setVoiceConfig({ ...voiceConfig.value, ...patch }, settingsStore.voiceHasApiKey),
    revert: () => settingsStore.setVoiceConfig({ ...voiceConfig.value, ...undo }, settingsStore.voiceHasApiKey),
  });
}

const removeFilesConfirmOpen = ref(false);
const returnFocus = useOpenerFocus(removeFilesConfirmOpen);

function confirmRemoveAll(): void {
  postMessage({ type: "voiceRemoveAllFiles" });
  removeFilesConfirmOpen.value = false;
}

const removeAllLabel = computed(() => {
  const formatted = formatVoiceFilesBytes(voiceFilesBytes.value);
  return formatted === null ? t("jarvisSettings.removeAll") : t("jarvisSettings.removeAllWithSize", { size: formatted });
});
</script>

<template>
  <SettingsRow
    v-if="wakeMode"
    id="damocles.voice.wakeWordSensitivity"
  >
    <SettingSlider
      :model-value="voiceConfig.wakeWordSensitivity ?? DEFAULT_WAKE_SENSITIVITY"
      :min="0.1"
      :max="0.95"
      :step="0.01"
      :label="t('jarvisSettings.sensitivityLabel')"
      :format="(value) => value.toFixed(2)"
      @update:model-value="(value) => update('damocles.voice.wakeWordSensitivity', buildSensitivityMessage(value), { wakeWordSensitivity: value })"
    />
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t("jarvisSettings.spokenRepliesTitle") }}
  </div>
  <SettingsRow id="damocles.voice.tts.enabled">
    <SettingSwitch
      :model-value="voiceConfig.ttsEnabled ?? false"
      :label="t('jarvisSettings.speakAssistantReplies')"
      @update:model-value="(enabled) => update('damocles.voice.tts.enabled', { type: 'setVoiceTtsEnabled', enabled }, { ttsEnabled: enabled })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.voice.tts.voice">
    <SettingSelect
      :model-value="voiceConfig.ttsVoice ?? DEFAULT_TTS_VOICE"
      :options="voiceOptions"
      :label="t('jarvisSettings.voicePicker')"
      :disabled="!voiceConfig.ttsEnabled"
      @update:model-value="(voice) => update('damocles.voice.tts.voice', { type: 'setVoiceTtsVoice', voice }, { ttsVoice: voice })"
    />
    <SettingButton
      :disabled="!voiceConfig.ttsEnabled"
      @click="postMessage({ type: 'voiceTestVoice' })"
    >
      {{ t("jarvisSettings.testVoice") }}
    </SettingButton>
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t("jarvisSettings.advanced") }}
  </div>
  <SettingsRow id="damocles.voice.localGpu">
    <SettingSeg
      :model-value="voiceConfig.localGpu ?? 'auto'"
      :options="gpuOptions"
      :label="t('jarvisSettings.gpuPreference')"
      @update:model-value="(preference) => update('damocles.voice.localGpu', buildGpuMessage(preference), { localGpu: preference })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.voice.autoSubmit">
    <SettingSwitch
      :model-value="voiceConfig.autoSubmit ?? true"
      :label="t('jarvisSettings.autoSubmit')"
      @update:model-value="(autoSubmit) => update('damocles.voice.autoSubmit', { type: 'setVoiceAutoSubmit', autoSubmit }, { autoSubmit })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.voice.endOfTurnSilenceMs">
    <SettingSlider
      :model-value="voiceConfig.endOfTurnSilenceMs ?? DEFAULT_END_OF_TURN_MS"
      :min="300"
      :max="3000"
      :step="50"
      :label="t('jarvisSettings.endOfTurn')"
      :format="(value) => `${value} ms`"
      @update:model-value="(ms) => update('damocles.voice.endOfTurnSilenceMs', buildEndOfTurnMessage(ms), { endOfTurnSilenceMs: ms })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.voice.maxUtteranceMs">
    <SettingSlider
      :model-value="voiceConfig.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS"
      :min="5000"
      :max="120000"
      :step="1000"
      :label="t('jarvisSettings.maxUtterance')"
      :format="(value) => `${(value / 1000).toFixed(1)} s`"
      @update:model-value="(ms) => update('damocles.voice.maxUtteranceMs', buildMaxUtteranceMessage(ms), { maxUtteranceMs: ms })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.voice.diagnostics">
    <SettingSwitch
      :model-value="voiceConfig.diagnostics ?? false"
      :label="t('jarvisSettings.diagnostics')"
      @update:model-value="(diagnostics) => update('damocles.voice.diagnostics', { type: 'setVoiceDiagnostics', diagnostics }, { diagnostics })"
    />
  </SettingsRow>
  <SettingsRow id="voice-files">
    <template #expand>
      <div class="sm-field-row sm-row-block">
        <SettingButton @click="postMessage({ type: 'voiceRedownloadModels' })">
          {{ t("jarvisSettings.redownload") }}
        </SettingButton>
        <SettingButton @click="postMessage({ type: 'voiceOpenModelsFolder' })">
          {{ t("jarvisSettings.openFolder") }}
        </SettingButton>
        <SettingButton @click="postMessage({ type: 'voiceFreeDiskSpace' })">
          {{ t("jarvisSettings.freeDiskSpace") }}
        </SettingButton>
        <SettingButton
          variant="danger"
          aria-haspopup="dialog"
          data-testid="voice-remove-all"
          @click="removeFilesConfirmOpen = true"
        >
          {{ removeAllLabel }}
        </SettingButton>
      </div>
    </template>
  </SettingsRow>
  <AlertDialog
    :open="removeFilesConfirmOpen"
    @update:open="(next: boolean) => (removeFilesConfirmOpen = next)"
  >
    <AlertDialogContent
      class="max-w-md gap-0 overflow-hidden p-0"
      data-testid="voice-remove-all-confirm"
      @close-auto-focus="returnFocus"
    >
      <ConfirmDialogLayout
        :icon="Trash2"
        tone="danger"
        :title="t('jarvisSettings.confirmRemoveTitle')"
        :description="t('jarvisSettings.confirmRemoveDescription')"
        :cancel-label="t('jarvisSettings.cancel')"
        :confirm-label="t('jarvisSettings.confirmRemoveAction')"
        danger
        @cancel="removeFilesConfirmOpen = false"
        @confirm="confirmRemoveAll"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
