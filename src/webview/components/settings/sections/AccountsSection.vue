<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { SettingsAccountId } from '@shared/settings-sections';
import { exploreSupportedEffortLevels } from '@shared/types/constants';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import ClaudeAuthPanel from '@/components/ClaudeAuthPanel.vue';
import OpenAIAuthPanel from '@/components/OpenAIAuthPanel.vue';
import CustomProviderAuthPanel from '@/components/CustomProviderAuthPanel.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingAccount from '../controls/SettingAccount.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingInput from '../controls/SettingInput.vue';
import SettingButton from '../controls/SettingButton.vue';
import { parseNonEmpty } from '../parsers';
import { useSettingWrite } from '../settings-writes';
import { useSettingsPage, useSettingsTarget } from '../settings-view';

const { t } = useI18n();
const page = useSettingsPage();
const target = useSettingsTarget();
const settingsStore = useSettingsStore();
const {
  claudeAuthMode,
  claudeAuthBusy,
  openaiAuthStatus,
  openaiChatGPTAuthInFlight,
  deepseekConfigured,
  stepfunConfigured,
  openrouterConfigured,
  typesafeConfigured,
  exploreProvider,
  exploreModel,
  exploreEffort,
  exploreHasApiKey,
} = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();
const write = useSettingWrite();

const expanded = ref<SettingsAccountId | null>(null);

// A chat that needs OpenAI sign-in asks for settings with that account row.
watch(target, (next) => {
  if (next?.account) expanded.value = next.account;
}, { immediate: true });

function toggle(provider: SettingsAccountId): void {
  expanded.value = expanded.value === provider ? null : provider;
}

interface AccountView {
  provider: SettingsAccountId;
  id: string;
  state: 'ok' | 'off' | 'busy';
  status: string;
  action: string;
}

const keyAccount = (provider: 'deepseek' | 'stepfun' | 'openrouter' | 'typesafe', configured: boolean): AccountView => ({
  provider,
  id: `account-${provider}`,
  state: configured ? 'ok' : 'off',
  status: configured ? t('settingsModal.account.keySaved') : t('settingsModal.account.notSetUp'),
  action: configured ? t('settingsModal.account.replaceKey') : t('settingsModal.account.addKey'),
});

const accounts = computed<AccountView[]>(() => {
  const openaiSignedIn = openaiAuthStatus.value.chatgpt.signedIn || openaiAuthStatus.value.codex.signedIn;
  const openaiConfigured = openaiSignedIn || openaiAuthStatus.value.apikey.configured;
  return [
    {
      provider: 'anthropic',
      id: 'account-anthropic',
      state: claudeAuthBusy.value ? 'busy' : claudeAuthMode.value === 'none' ? 'off' : 'ok',
      status: claudeAuthBusy.value
        ? t('settingsModal.account.signingIn')
        : claudeAuthMode.value === 'none' ? t('settingsModal.account.notSetUp') : t(`claudeAuth.status.${claudeAuthMode.value}`),
      action: claudeAuthMode.value === 'none' ? t('settingsModal.account.signIn') : t('settingsModal.account.manage'),
    },
    {
      provider: 'openai',
      id: 'account-openai',
      state: openaiChatGPTAuthInFlight.value ? 'busy' : openaiConfigured ? 'ok' : 'off',
      status: openaiChatGPTAuthInFlight.value
        ? t('settingsModal.account.signingIn')
        : openaiSignedIn
          ? t('settingsModal.account.signedIn')
          : openaiConfigured
            ? t('settingsModal.account.keySaved')
            : t('settingsModal.account.notSetUp'),
      action: openaiConfigured ? t('settingsModal.account.manage') : t('settingsModal.account.signIn'),
    },
    keyAccount('deepseek', deepseekConfigured.value),
    keyAccount('stepfun', stepfunConfigured.value),
    keyAccount('openrouter', openrouterConfigured.value),
    keyAccount('typesafe', typesafeConfigured.value),
  ];
});

const providerChoices = computed(() => [
  { value: 'default', label: t('settings.explore.providerDefault') },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'stepfun', label: 'StepFun' },
]);
const thirdParty = computed(() => exploreProvider.value !== 'default');
// StepFun's key is managed by its account row, which shares the secret.
const needsKey = computed(() => thirdParty.value && exploreProvider.value !== 'stepfun');
const effortLevels = computed(() => exploreSupportedEffortLevels(exploreProvider.value, exploreModel.value));
const effortChoices = computed(() => [
  { value: 'default', label: t('settings.explore.effortDefault') },
  ...effortLevels.value.map((level) => ({ value: level as string, label: t(`settingsModal.effort.${level}`) })),
]);
const exploreDescription = computed(() => {
  switch (exploreProvider.value) {
    case 'default': return t('settings.explore.descriptionDefault');
    case 'gemini': return t('settings.explore.descriptionGemini');
    case 'stepfun': return t('settings.explore.descriptionStepfun');
    default: return t('settings.explore.descriptionOpenrouter');
  }
});
const keyPlaceholder = computed(() => (exploreProvider.value === 'gemini' ? t('settings.explore.apiKeyPlaceholderGemini') : t('settings.explore.apiKeyPlaceholderOpenrouter')));

interface ExploreConfig {
  provider: string;
  model: string;
  effort: string;
}

function setExploreField(field: keyof ExploreConfig, value: string, key: string, message: Parameters<typeof write>[1]): void {
  const current = (): ExploreConfig => ({ provider: exploreProvider.value, model: exploreModel.value, effort: exploreEffort.value });
  const store = (config: ExploreConfig): void => settingsStore.setExploreConfig(config.provider, config.model, config.effort);
  const before = current()[field];
  // The revert puts back only this field, so it never undoes another Explore row's write.
  write(key, message, {
    apply: () => store({ ...current(), [field]: value }),
    revert: () => store({ ...current(), [field]: before }),
  });
}

function setProvider(provider: string): void {
  setExploreField('provider', provider, 'damocles.explore.provider', { type: 'setExploreProvider', provider });
}

function setModel(model: string): void {
  setExploreField('model', model, 'damocles.explore.modelByProvider', { type: 'setExploreModel', model });
}

function setEffort(value: string): void {
  const effort = value === 'default' ? '' : value;
  setExploreField('effort', effort, 'damocles.explore.effort', { type: 'setExploreEffort', effort });
}

const exploreKey = ref('');
function saveExploreKey(): void {
  const apiKey = exploreKey.value.trim();
  if (!apiKey) return;
  postMessage({ type: 'setExploreApiKey', apiKey });
  exploreKey.value = '';
}
</script>

<template>
  <SettingsRow
    v-for="account in accounts"
    :id="account.id"
    :key="account.id"
  >
    <SettingAccount
      :state="account.state"
      :status="account.status"
      :action="account.action"
      :action-label="`${account.action}: ${t(`settingsModal.rows.${account.provider}.label`)}`"
      :expanded="expanded === account.provider"
      :controls="`settings-account-${account.provider}`"
      @toggle="toggle(account.provider)"
    />
    <template #expand>
      <div
        v-if="expanded === account.provider"
        :id="`settings-account-${account.provider}`"
        class="sm-expand"
      >
        <ClaudeAuthPanel v-if="account.provider === 'anthropic'" />
        <OpenAIAuthPanel v-else-if="account.provider === 'openai'" />
        <CustomProviderAuthPanel
          v-else
          :provider="account.provider"
        />
      </div>
    </template>
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t('settingsModal.groups.explore') }}
  </div>
  <SettingsRow
    id="damocles.explore.provider"
    :description="exploreDescription"
  >
    <SettingSelect
      :model-value="exploreProvider"
      :options="providerChoices"
      :label="t('settingsModal.rows.exploreProvider.label')"
      @update:model-value="setProvider"
    />
  </SettingsRow>
  <SettingsRow
    v-if="thirdParty"
    id="damocles.explore.modelByProvider"
  >
    <SettingInput
      :model-value="exploreModel"
      :parse="(raw) => parseNonEmpty(raw, t)"
      :label="t('settingsModal.rows.exploreModel.label')"
      :placeholder="t('settings.explore.modelPlaceholder')"
      wide
      @commit="setModel"
    />
  </SettingsRow>
  <SettingsRow
    v-if="thirdParty && effortLevels.length > 0"
    id="damocles.explore.effort"
  >
    <SettingSelect
      :model-value="effortChoices.some((choice) => choice.value === exploreEffort) ? exploreEffort : 'default'"
      :options="effortChoices"
      :label="t('settingsModal.rows.exploreEffort.label')"
      @update:model-value="setEffort"
    />
  </SettingsRow>
  <SettingsRow
    v-if="needsKey"
    id="explore-api-key"
    :description="exploreHasApiKey ? t('settings.explore.keyStored') : t('settings.explore.noKey')"
  >
    <div class="sm-input sm-input-wide">
      <input
        v-model="exploreKey"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        :aria-label="t('settingsModal.rows.exploreApiKey.label')"
        :placeholder="keyPlaceholder"
        @keydown.enter.prevent="saveExploreKey"
      >
    </div>
    <SettingButton
      :disabled="!exploreKey.trim()"
      @click="saveExploreKey"
    >
      {{ t('common.save') }}
    </SettingButton>
    <SettingButton
      v-if="exploreHasApiKey"
      variant="danger"
      @click="postMessage({ type: 'deleteExploreApiKey' })"
    >
      {{ t('settings.explore.deleteKey') }}
    </SettingButton>
  </SettingsRow>
</template>
