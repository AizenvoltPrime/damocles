<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Mic } from 'lucide-vue-next';
import type { VoiceConfig, VoiceMode, VoiceProvider, VoiceRuntimeStatus } from '@shared/types/voice';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Progress } from '@/components/ui/progress';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenerFocus } from '@/composables/useOpenerFocus';
import { useSettingsStore } from '@/stores/useSettingsStore';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import JarvisSettings from '@/components/JarvisSettings.vue';
import VoiceDisclosure from '@/components/VoiceDisclosure.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingButton from '../controls/SettingButton.vue';
import { useSettingWrite } from '../settings-writes';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { voiceConfig, voiceHasApiKey, voiceRuntimeStatus } = storeToRefs(settingsStore);
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

const runtimeUnsupported = computed(() => (voiceRuntimeStatus.value.kind === 'unsupported' ? voiceRuntimeStatus.value.message : null));
const runtimeStarting = computed(() => (voiceRuntimeStatus.value.kind === 'starting' ? voiceRuntimeStatus.value : null));

const runtimeText = computed(() => {
  const status = voiceRuntimeStatus.value;
  switch (status.kind) {
    case 'starting': return t(`settings.voice.runtime.stage.${status.stage}`);
    case 'needs-install':
    case 'failed': return status.message;
    case 'idle':
    case 'ready':
    case 'cancelled': return t(`settings.voice.runtime.${status.kind}`);
    default: return '';
  }
});

// A pip or smoke-check failure runs to 30 lines: the row shows the first and folds the rest under Details.
const runtimeSummary = computed(() => runtimeText.value.split('\n', 1)[0] ?? '');
const runtimeDetails = computed(() => runtimeText.value.split('\n').slice(1).join('\n').trim());

const RUNTIME_TONE: Partial<Record<VoiceRuntimeStatus['kind'], string>> = {
  'needs-install': 'sm-feedback-warning',
  failed: 'sm-feedback-error',
};

type RuntimeAction = 'start' | 'install' | 'retry' | 'cancel';
const RUNTIME_ACTIONS: Partial<Record<VoiceRuntimeStatus['kind'], RuntimeAction>> = {
  idle: 'start',
  'needs-install': 'install',
  cancelled: 'install',
  failed: 'retry',
  starting: 'cancel',
};
const runtimeAction = computed(() => RUNTIME_ACTIONS[voiceRuntimeStatus.value.kind]);

const consentOpen = ref(false);
const returnFocus = useOpenerFocus(consentOpen);
// A start this row asked for, until its outcome arrives: one that found something to download without consent asks for it.
const awaitingStart = ref(false);
const needsConsent = (status: VoiceRuntimeStatus): boolean => status.kind === 'needs-install' && status.consentRequired;

function runAction(action: RuntimeAction): void {
  if (action === 'cancel') {
    postMessage({ type: 'voiceRuntimeCancel' });
    return;
  }
  if (needsConsent(voiceRuntimeStatus.value)) {
    consentOpen.value = true;
    return;
  }
  awaitingStart.value = true;
  postMessage({ type: 'voiceRuntimeInstall' });
}

watch(voiceRuntimeStatus, (status) => {
  if (!awaitingStart.value || status.kind === 'idle' || status.kind === 'starting') return;
  awaitingStart.value = false;
  if (needsConsent(status)) consentOpen.value = true;
});

function acceptDownloads(): void {
  consentOpen.value = false;
  postMessage({ type: 'voiceRuntimeInstall', consent: true });
}
</script>

<template>
  <SettingsRow id="damocles.voice.mode">
    <template
      v-if="runtimeUnsupported"
      #note
    >
      <p
        class="sm-feedback sm-feedback-warning"
        data-testid="voice-runtime-unsupported"
      >
        {{ runtimeUnsupported }}
      </p>
    </template>
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
  <!-- Mounted with the section, not the row, so a screen reader announces the row's first state too. -->
  <p
    class="sr-only"
    aria-live="polite"
    data-testid="voice-runtime-announcement"
  >
    {{ runtimeSummary }}
  </p>
  <SettingsRow
    v-if="runtimeText"
    id="voice-runtime"
  >
    <template #note>
      <p
        class="sm-feedback"
        :class="RUNTIME_TONE[voiceRuntimeStatus.kind]"
        data-testid="voice-runtime-status"
      >
        {{ runtimeSummary }}
        <span
          v-if="runtimeStarting?.installing"
          aria-hidden="true"
        >{{ runtimeStarting.pct }}%</span>
      </p>
      <details
        v-if="runtimeDetails"
        class="mt-1 text-xs text-(--d-muted)"
        data-testid="voice-runtime-details"
      >
        <summary class="cursor-pointer select-none">
          {{ t('settings.voice.runtime.details') }}
        </summary>
        <pre class="mt-1 max-h-40 overflow-auto font-mono wrap-break-word whitespace-pre-wrap">{{ runtimeDetails }}</pre>
      </details>
      <Progress
        v-if="runtimeStarting?.installing"
        :model-value="runtimeStarting.pct"
        :aria-label="runtimeSummary"
        class="mt-1.5 h-1.5 w-full max-w-60"
        data-testid="voice-runtime-progress"
      />
    </template>
    <SettingButton
      v-if="runtimeAction"
      :data-testid="`voice-runtime-${runtimeAction}`"
      @click="runAction(runtimeAction)"
    >
      {{ t(`settings.voice.runtime.action.${runtimeAction}`) }}
    </SettingButton>
  </SettingsRow>
  <AlertDialog
    :open="consentOpen"
    @update:open="(next: boolean) => (consentOpen = next)"
  >
    <AlertDialogContent
      class="max-h-[calc(100%-2rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
      data-testid="voice-runtime-consent"
      @close-auto-focus="returnFocus"
    >
      <ConfirmDialogLayout
        :icon="Mic"
        :title="t('voiceFirstRun.title')"
        :description="t('voiceFirstRun.sizeRuntime')"
        :cancel-label="t('voiceFirstRun.cancel')"
        :confirm-label="t('voiceFirstRun.accept')"
        @cancel="consentOpen = false"
        @confirm="acceptDownloads"
      >
        <VoiceDisclosure />
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
  <JarvisSettings v-if="voiceConfig.mode !== 'off'" />
</template>
