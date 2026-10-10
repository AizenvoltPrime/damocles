<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { SettingsAccountId } from '@shared/settings-sections';
import { DEFAULT_MODELS } from '@shared/types/constants';
import { MEMORY_JUDGE_CLASSIFIERS } from '@shared/memory-judge';
import { modelVendor, type ModelVendor } from '@/composables/useModelIdentity';
import { useSettingsStore } from '@/stores/useSettingsStore';
import ClaudeAuthPanel from '@/components/ClaudeAuthPanel.vue';
import OpenAIAuthPanel from '@/components/OpenAIAuthPanel.vue';
import CustomProviderAuthPanel from '@/components/CustomProviderAuthPanel.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingAccount from '../controls/SettingAccount.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import { useMemoryJudgeNames } from '../memory-judge-names';
import { useModelEffortPair } from '../model-effort-pair';
import { modelOptions, UNSET_OPTION } from '../model-options';
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
  classifierCredentials,
  memoryJudge,
  currentSettings,
} = storeToRefs(settingsStore);

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

// Whether each model vendor has a credential; the account rows and the model choices both read this one answer.
const vendorSignedIn = computed<Record<ModelVendor, boolean>>(() => ({
  anthropic: claudeAuthMode.value !== 'none',
  openai: openaiAuthStatus.value.chatgpt.signedIn || openaiAuthStatus.value.codex.signedIn || openaiAuthStatus.value.apikey.configured,
  deepseek: deepseekConfigured.value,
  stepfun: stepfunConfigured.value,
}));

const keyAccount = (provider: 'deepseek' | 'stepfun' | 'openrouter' | 'typesafe', configured: boolean): AccountView => ({
  provider,
  id: `account-${provider}`,
  state: configured ? 'ok' : 'off',
  status: configured ? t('settingsModal.account.keySaved') : t('settingsModal.account.notSetUp'),
  action: configured ? t('settingsModal.account.replaceKey') : t('settingsModal.account.addKey'),
});

const accounts = computed<AccountView[]>(() => {
  const openaiSignedIn = openaiAuthStatus.value.chatgpt.signedIn || openaiAuthStatus.value.codex.signedIn;
  const openaiConfigured = vendorSignedIn.value.openai;
  return [
    {
      provider: 'anthropic',
      id: 'account-anthropic',
      state: claudeAuthBusy.value ? 'busy' : vendorSignedIn.value.anthropic ? 'ok' : 'off',
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
    keyAccount('deepseek', vendorSignedIn.value.deepseek),
    keyAccount('stepfun', vendorSignedIn.value.stepfun),
    keyAccount('openrouter', openrouterConfigured.value),
    keyAccount('typesafe', typesafeConfigured.value),
  ];
});

// The host resolves these settings against the whole catalog, not the chat's model list.
const catalogChoices = computed(() => modelOptions(DEFAULT_MODELS, (model) => (vendorSignedIn.value[modelVendor(model)] ? undefined : t('settings.modelNotSignedIn'))));

const explore = useModelEffortPair({
  read: () => currentSettings.value.explore,
  store: (next) => settingsStore.setExploreSettings(next),
  modelKey: 'damocles.explore.model',
  effortKey: 'damocles.explore.effort',
  modelMessage: (model) => ({ type: 'setExploreModel', model }),
  effortMessage: (effort) => ({ type: 'setExploreEffort', effort }),
  effortUnsetLabel: () => t('settings.explore.effortDefault'),
});
const exploreModelChoices = computed(() => [{ value: UNSET_OPTION, label: t('settings.explore.modelDefault') }, ...catalogChoices.value]);

const background = useModelEffortPair({
  read: () => currentSettings.value.background,
  store: (next) => settingsStore.setBackgroundSettings(next),
  modelKey: 'damocles.background.model',
  effortKey: 'damocles.background.effort',
  modelMessage: (model) => ({ type: 'setBackgroundModel', model }),
  effortMessage: (effort) => ({ type: 'setBackgroundEffort', effort }),
  effortUnsetLabel: () => t('settings.background.effortPerJob'),
});
const backgroundModelChoices = computed(() => [{ value: UNSET_OPTION, label: t('settings.background.modelAutomatic') }, ...catalogChoices.value]);

const judge = useModelEffortPair({
  read: () => ({ model: currentSettings.value.judge.choice, effort: currentSettings.value.judge.effort }),
  store: ({ model, effort }) => settingsStore.setJudgeSettings({ choice: model, effort }),
  modelKey: 'damocles.memory.judge',
  effortKey: 'damocles.memory.judgeEffort',
  modelMessage: (choice) => ({ type: 'setMemoryJudge', judge: choice }),
  effortMessage: (effort) => ({ type: 'setMemoryJudgeEffort', effort }),
  effortUnsetLabel: () => t('settings.background.effortPerJob'),
});
const { classifierName, judgeText } = useMemoryJudgeNames();
// A classifier whose key is missing stays listed, disabled with the reason, so the choice is discoverable.
const judgeChoices = computed(() => [
  { value: UNSET_OPTION, label: t('settings.memoryJudge.automatic') },
  ...MEMORY_JUDGE_CLASSIFIERS.map(({ choice, provider }) => {
    const credential = classifierCredentials.value?.[provider] ?? 'ok';
    return {
      value: choice,
      label: classifierName(provider),
      ...(credential === 'ok' ? {} : { disabled: true, hint: t(`settings.memoryJudge.unavailable.${credential}`) }),
    };
  }),
  ...catalogChoices.value,
]);
// The host's reason the chosen judge cannot run, shown where the choice is made.
const judgeWarning = computed(() => {
  const status = memoryJudge.value;
  return status?.kind === 'none' && status.forced ? t('typesafe.memoryJudge.label', { judge: judgeText(status) }) : '';
});
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
  <SettingsRow id="damocles.explore.model">
    <SettingSelect
      :model-value="explore.modelValue.value"
      :options="exploreModelChoices"
      :label="t('settingsModal.rows.exploreModel.label')"
      @update:model-value="explore.setModel"
    />
    <SettingSelect
      v-if="explore.effortChoices.value.length > 0"
      :model-value="explore.effortValue.value"
      :options="explore.effortChoices.value"
      :label="t('settingsModal.rows.exploreEffort.label')"
      @update:model-value="explore.setEffort"
    />
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t('settingsModal.groups.background') }}
  </div>
  <SettingsRow id="damocles.background.model">
    <SettingSelect
      :model-value="background.modelValue.value"
      :options="backgroundModelChoices"
      :label="t('settingsModal.rows.backgroundModel.label')"
      @update:model-value="background.setModel"
    />
    <SettingSelect
      v-if="background.effortChoices.value.length > 0"
      :model-value="background.effortValue.value"
      :options="background.effortChoices.value"
      :label="t('settingsModal.rows.backgroundEffort.label')"
      @update:model-value="background.setEffort"
    />
  </SettingsRow>
  <SettingsRow id="damocles.memory.judge">
    <template #note>
      <p
        role="status"
        data-testid="memory-judge-warning"
        :class="{ 'sm-feedback sm-feedback-warning': judgeWarning }"
      >
        {{ judgeWarning }}
      </p>
    </template>
    <SettingSelect
      :model-value="judge.modelValue.value"
      :options="judgeChoices"
      :label="t('settingsModal.rows.memoryJudge.label')"
      @update:model-value="judge.setModel"
    />
    <SettingSelect
      v-if="judge.effortChoices.value.length > 0"
      :model-value="judge.effortValue.value"
      :options="judge.effortChoices.value"
      :label="t('settingsModal.rows.memoryJudgeEffort.label')"
      @update:model-value="judge.setEffort"
    />
  </SettingsRow>
</template>
