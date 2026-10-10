<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { thinkingDisableApplies } from '@shared/types/constants';
import type { EffortLevel, PermissionMode } from '@shared/types/settings';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingsRow from '../SettingsRow.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { effortOptions, modelOptions, permissionOptions } from '../model-options';
import { useSettingsPage } from '../settings-view';

const { t } = useI18n();
const page = useSettingsPage();
const settingsStore = useSettingsStore();
const { postMessage } = usePlatformBridge();
const {
  availableModels,
  activeModel,
  defaultModel,
  panelThinking,
  panelThinkingModel,
  currentSettings,
  workspaceFolders,
  panelWorkspaceFolderKey,
  workspaceFolderSwitchPending,
} = storeToRefs(settingsStore);

const folderOptions = computed(() => workspaceFolders.value.map((folder) => ({ value: folder.key, label: folder.label, hint: folder.path })));

const chatModel = computed(() => activeModel.value || defaultModel.value);
const thinkingModel = computed(() => availableModels.value.find((model) => model.value === (panelThinkingModel.value || chatModel.value)));
const effortLevels = computed(() => thinkingModel.value?.supportedEffortLevels ?? []);
const adaptive = computed(() => thinkingModel.value?.supportsAdaptiveThinking ?? false);
const disableApplies = computed(() => thinkingDisableApplies(thinkingModel.value));
const openai = computed(() => thinkingModel.value?.backend === 'openai');
const thinkingOn = computed(() => panelThinking.value !== null && (!panelThinking.value.thinkingDisabled || openai.value));

function setModel(model: string): void {
  // Sent for the current model too, which withdraws a pick core holds for a sign-in; the select changes only on core's modelUpdate.
  postMessage({ type: 'setActiveModel', model });
}

function setEffort(effort: EffortLevel): void {
  postMessage({ type: 'setPanelEffort', effort, model: panelThinkingModel.value || chatModel.value });
}

function setThinkingDisabled(disabled: boolean): void {
  postMessage({ type: 'setPanelThinkingDisabled', disabled });
}

function setPermissionMode(mode: PermissionMode): void {
  settingsStore.setPermissionMode(mode);
  postMessage({ type: 'setPermissionMode', mode });
}
</script>

<template>
  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t('settingsModal.groups.workspace') }}
  </div>
  <SettingsRow
    v-if="folderOptions.length > 0"
    id="workspace-folder"
  >
    <SettingSelect
      :model-value="panelWorkspaceFolderKey"
      :options="folderOptions"
      :label="t('settingsModal.rows.workspaceFolder.label')"
      :disabled="folderOptions.length < 2 || workspaceFolderSwitchPending"
      @update:model-value="settingsStore.requestPanelWorkspaceFolder"
    />
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t('settingsModal.groups.model') }}
  </div>
  <SettingsRow id="model">
    <SettingSelect
      :model-value="chatModel"
      :options="modelOptions(availableModels)"
      :label="t('settingsModal.rows.model.label')"
      reselectable
      @update:model-value="setModel"
    />
  </SettingsRow>
  <SettingsRow
    v-if="panelThinking && thinkingOn && adaptive && effortLevels.length > 0"
    id="effort"
  >
    <SettingSeg
      :model-value="panelThinking.effort ?? effortLevels[0]!"
      :options="effortOptions(effortLevels, t)"
      :label="t('settingsModal.rows.effort.label')"
      @update:model-value="setEffort"
    />
  </SettingsRow>
  <SettingsRow
    v-if="panelThinking"
    id="disable-thinking"
    :description="disableApplies ? undefined : t('settings.thinkingAlwaysOn')"
  >
    <SettingSwitch
      :model-value="disableApplies && panelThinking.thinkingDisabled"
      :label="t('settingsModal.rows.disableThinking.label')"
      :disabled="!disableApplies"
      @update:model-value="setThinkingDisabled"
    />
  </SettingsRow>
  <SettingsRow id="permission-mode">
    <SettingSeg
      :model-value="currentSettings.permissionMode"
      :options="permissionOptions(t)"
      :label="t('settingsModal.rows.permissionMode.label')"
      @update:model-value="setPermissionMode"
    />
  </SettingsRow>
</template>
