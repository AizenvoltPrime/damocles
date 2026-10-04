<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { VoiceConfig, VoiceMode, VoiceProvider } from '@shared/types/voice';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import JarvisSettings from '@/components/JarvisSettings.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingButton from '../controls/SettingButton.vue';
import { useSettingWrite } from '../settings-writes';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { voiceConfig, voiceHasApiKey } = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();
const write = useSettingWrite();

const modeOptions = computed<{ value: VoiceMode; label: string }[]>(() => [
  { value: 'off', label: t('settingsModal.voiceMode.off') },
  { value: 'push-to-talk', label: t('settingsModal.voiceMode.pushToTalk') },
  { value: 'wake-word', label: t('settingsModal.voiceMode.wakeWord') },
]);

const providerOptions: { value: VoiceProvider; label: string }[] = [
  { value: 'openai-whisper', label: 'OpenAI Whisper' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'google-cloud-stt', label: 'Google Cloud STT' },
];

// Endonyms, so each language is recognizable whatever the UI language is.
const languageOptions: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'el', label: 'Ελληνικά' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'ru', label: 'Русский' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '中文' },
  { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'pl', label: 'Polski' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'sv', label: 'Svenska' },
  { value: 'da', label: 'Dansk' },
  { value: 'uk', label: 'Українська' },
];

function update(key: string, message: WebviewToExtensionMessage, patch: Partial<VoiceConfig>): void {
  // The revert puts back only the patched fields, so it never undoes another voice row's write.
  const undo: Partial<VoiceConfig> = Object.fromEntries(Object.keys(patch).map((field) => [field, voiceConfig.value[field as keyof VoiceConfig]]));
  write(key, message, {
    apply: () => settingsStore.setVoiceConfig({ ...voiceConfig.value, ...patch }, voiceHasApiKey.value),
    revert: () => settingsStore.setVoiceConfig({ ...voiceConfig.value, ...undo }, voiceHasApiKey.value),
  });
}

const apiKey = ref('');
function saveKey(): void {
  const key = apiKey.value.trim();
  if (!key) return;
  postMessage({ type: 'setVoiceApiKey', provider: voiceConfig.value.provider, apiKey: key });
  apiKey.value = '';
}

function setProvider(provider: VoiceProvider): void {
  apiKey.value = '';
  update('damocles.voice.provider', { type: 'setVoiceProvider', provider }, { provider });
}
</script>

<template>
  <SettingsRow id="damocles.voice.mode">
    <SettingSeg
      :model-value="voiceConfig.mode"
      :options="modeOptions"
      :label="t('settingsModal.rows.voiceMode.label')"
      @update:model-value="(mode) => update('damocles.voice.mode', { type: 'setVoiceMode', mode }, { mode })"
    />
  </SettingsRow>
  <template v-if="voiceConfig.mode === 'push-to-talk'">
    <SettingsRow id="damocles.voice.provider">
      <SettingSelect
        :model-value="voiceConfig.provider"
        :options="providerOptions"
        :label="t('settingsModal.rows.voiceProvider.label')"
        @update:model-value="setProvider"
      />
    </SettingsRow>
    <SettingsRow
      id="voice-api-key"
      :description="voiceHasApiKey ? t('settings.voice.keyStored') : t('settings.voice.noKey')"
    >
      <div class="sm-input sm-input-wide">
        <input
          v-model="apiKey"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :aria-label="t('settingsModal.rows.voiceApiKey.label')"
          :placeholder="t('settings.voice.apiKeyPlaceholder')"
          @keydown.enter.prevent="saveKey"
        >
      </div>
      <SettingButton
        :disabled="!apiKey.trim()"
        @click="saveKey"
      >
        {{ t('common.save') }}
      </SettingButton>
      <SettingButton
        v-if="voiceHasApiKey"
        variant="danger"
        @click="postMessage({ type: 'deleteVoiceApiKey', provider: voiceConfig.provider })"
      >
        {{ t('settings.voice.deleteKey') }}
      </SettingButton>
    </SettingsRow>
    <SettingsRow id="damocles.voice.language">
      <SettingSelect
        :model-value="voiceConfig.language"
        :options="languageOptions"
        :label="t('settingsModal.rows.voiceLanguage.label')"
        @update:model-value="(language) => update('damocles.voice.language', { type: 'setVoiceLanguage', language }, { language })"
      />
    </SettingsRow>
  </template>
  <JarvisSettings v-if="voiceConfig.mode !== 'off'" />
</template>
