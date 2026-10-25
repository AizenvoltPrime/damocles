<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { ACCOUNT_PROVIDER_IDS, isKeyProviderId, isSignInProviderId, type AccountProviderId, type SettingsAccountId } from '@shared/settings-sections';
import { MEMORY_JUDGE_CLASSIFIERS } from '@shared/memory-judge';
import { isModelVendor, modelVendor, MODEL_PICKER_SETTING, type ModelVendor } from '@shared/model-vendor';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore, type KeyProviderStatus } from '@/stores/useSettingsStore';
import ClaudeAuthPanel from '@/components/ClaudeAuthPanel.vue';
import OpenAIAuthPanel from '@/components/OpenAIAuthPanel.vue';
import CustomProviderAuthPanel from '@/components/CustomProviderAuthPanel.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingAccount from '../controls/SettingAccount.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { useMemoryJudgeNames } from '../memory-judge-names';
import { useModelEffortPair } from '../model-effort-pair';
import { modelOptions, useUnavailableHint, UNSET_OPTION } from '../model-options';
import { useSettingsPage, useSettingsTarget } from '../settings-view';

const { t } = useI18n();
const unavailableHint = useUnavailableHint();
const page = useSettingsPage();
const target = useSettingsTarget();
const settingsStore = useSettingsStore();
const {
  claudeAuthMode,
  claudeAuthBusy,
  openaiAuthStatus,
  openaiChatGPTAuthInFlight,
  keyProviderStatus,
  providerSignInState,
  classifierCredentials,
  memoryJudge,
  currentSettings,
  accountInfo,
  writableKeys,
  availableModels,
} = storeToRefs(settingsStore);
const { postMessage, onMessage } = usePlatformBridge();

const expanded = ref<SettingsAccountId | null>(null);

// A chat that needs a sign-in or a new key asks for settings with that account row.
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
  ...(Object.fromEntries(ACCOUNT_PROVIDER_IDS.map((provider) => [provider, keySignedIn(provider)])) as Record<AccountProviderId, boolean>),
}));

// pi runs a provider on a key from the environment or its own config too, so that counts as signed in.
function keySignedIn(provider: AccountProviderId): boolean {
  const status = keyProviderStatus.value[provider];
  return status.configured || status.signedIn || status.external !== null;
}

function externalStatus(status: KeyProviderStatus): string {
  if (status.external === 'environment') return t('settingsModal.account.keyFromEnvironment');
  if (status.external === 'piConfig') return t('settingsModal.account.keyFromPiConfig');
  return t('settingsModal.account.notSetUp');
}

// Names the credential core says is active; without `active` it lists what exists and never picks between a sign-in and a key.
function keyStatus(provider: AccountProviderId): string {
  const status = keyProviderStatus.value[provider];
  switch (status.active) {
    case 'signIn': return t('settingsModal.account.signedIn');
    case 'apiKey': return t('settingsModal.account.keySaved');
    case 'external': return externalStatus(status);
    case 'none': return t('settingsModal.account.notSetUp');
  }
  if (status.signedIn && status.configured) return t('settingsModal.account.signedInAndKeySaved');
  if (status.signedIn) return t('settingsModal.account.signedIn');
  if (status.configured) return t('settingsModal.account.keySaved');
  return externalStatus(status);
}

function signInRunning(provider: AccountProviderId): boolean {
  return isSignInProviderId(provider) && providerSignInState.value[provider].phase !== 'idle';
}

// A sign-in-only provider has no key to add or replace.
function keyAction(provider: AccountProviderId): string {
  const status = keyProviderStatus.value[provider];
  if (!isKeyProviderId(provider)) return status.signedIn ? t('settingsModal.account.manage') : t('settingsModal.account.signIn');
  return status.configured ? t('settingsModal.account.replaceKey') : t('settingsModal.account.addKey');
}

const keyAccount = (provider: AccountProviderId): AccountView => ({
  provider,
  id: `account-${provider}`,
  state: signInRunning(provider) ? 'busy' : keySignedIn(provider) ? 'ok' : 'off',
  status: signInRunning(provider) ? t('settingsModal.account.signingIn') : keyStatus(provider),
  action: keyAction(provider),
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
    ...ACCOUNT_PROVIDER_IDS.map((provider) => keyAccount(provider)),
  ];
});

// A switch shows the value it sent until core acknowledges it, and core's picker providers after.
const pickerPending = ref<Partial<Record<ModelVendor, { requestId: string; shown: boolean }>>>({});

// A user-only setting: a remote chat's host tab cannot write it.
const pickerWritable = computed(() => writableKeys.value === undefined || writableKeys.value.has(MODEL_PICKER_SETTING));
// The switches wait for core's picker providers, which it publishes once pi has started.
const pickerProviders = computed(() => accountInfo.value?.pickerProviders);

function shownInPicker(vendor: SettingsAccountId): boolean {
  if (!isModelVendor(vendor)) return false;
  return pickerPending.value[vendor]?.shown ?? pickerProviders.value?.includes(vendor) ?? false;
}

function setShownInPicker(vendor: SettingsAccountId, shown: boolean): void {
  if (!isModelVendor(vendor)) return;
  const requestId = `model-picker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  pickerPending.value = { ...pickerPending.value, [vendor]: { requestId, shown } };
  postMessage({ type: 'setModelPickerProvider', provider: vendor, shown, requestId });
}

function handlePickerAck(msg: ExtensionToWebviewMessage): void {
  if (msg.type !== 'setModelPickerProviderAck' || pickerPending.value[msg.provider]?.requestId !== msg.requestId) return;
  const { [msg.provider]: _settled, ...rest } = pickerPending.value;
  pickerPending.value = rest;
}

let stopAcks: (() => void) | null = null;
onMounted(() => {
  stopAcks = onMessage(handlePickerAck);
});
onUnmounted(() => stopAcks?.());

// The host resolves these settings against the whole catalog, which the chat's model list is, with core's marks.
const catalogChoices = computed(() => modelOptions(availableModels.value, (model) => (vendorSignedIn.value[modelVendor(model)] ? unavailableHint(model) : t('settings.modelNotSignedIn'))));

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
        <label
          v-if="pickerWritable && pickerProviders !== undefined && isModelVendor(account.provider)"
          class="sm-field-row mt-3"
        >
          <SettingSwitch
            :model-value="shownInPicker(account.provider)"
            :aria-labelledby="`settings-account-${account.provider}-picker`"
            :data-testid="`model-picker-switch-${account.provider}`"
            @update:model-value="(shown: boolean) => setShownInPicker(account.provider, shown)"
          />
          <span
            :id="`settings-account-${account.provider}-picker`"
            class="sm-field-label flex-1"
          >{{ t('settingsModal.account.showInPicker') }}</span>
        </label>
      </div>
    </template>
  </SettingsRow>

  <div
    v-if="page.groupShown(['damocles.explore.model'])"
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
    v-if="page.groupShown(['damocles.background.model', 'damocles.memory.judge'])"
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
