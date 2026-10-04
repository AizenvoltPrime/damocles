<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingsRow from '../SettingsRow.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { useSettingWrite } from '../settings-writes';
import { useToolGroupSwitch, type SwitchableToolGroup } from '../tool-groups';
import { useSettingsPage } from '../settings-view';

const { t } = useI18n();
const page = useSettingsPage();
const settingsStore = useSettingsStore();
const { mcpEnabled, imageGeneration } = storeToRefs(settingsStore);
const write = useSettingWrite();

const groups: { group: SwitchableToolGroup; id: string; name: string }[] = [
  { group: 'memory', id: 'damocles.memory.enabled', name: 'memory' },
  { group: 'compass', id: 'damocles.compass.enabled', name: 'compass' },
  { group: 'browser', id: 'damocles.browser.enabled', name: 'browser' },
  { group: 'web', id: 'damocles.pi.webSearch.enabled', name: 'webSearch' },
];
const switches = groups.map((entry) => ({ ...entry, control: useToolGroupSwitch(entry.group) }));

function setMcp(enabled: boolean): void {
  write('damocles.mcp.enabled', { type: 'setMcpEnabled', enabled }, {
    apply: () => settingsStore.setMcpEnabled(enabled),
    revert: () => settingsStore.setMcpEnabled(!enabled),
  });
}

const imageModelOptions = computed(() => (imageGeneration.value?.imageModels ?? []).map((model) => ({ value: model.id, label: model.name })));
const imageModelUnknown = computed(() => {
  const settings = imageGeneration.value;
  return settings !== null && settings.model !== '' && !settings.imageModels.some((model) => model.id === settings.model);
});

// The revert puts back only the patched field, so it never undoes the other image row's write.
function setImage(key: string, message: Parameters<typeof write>[1], patch: { enabled: boolean } | { model: string }): void {
  const before = imageGeneration.value;
  if (!before) return;
  const undo = 'enabled' in patch ? { enabled: before.enabled } : { model: before.model };
  write(key, message, {
    apply: () => settingsStore.setImageGeneration({ ...before, ...patch }),
    revert: () => settingsStore.setImageGeneration({ ...(imageGeneration.value ?? before), ...undo }),
  });
}

function setImageEnabled(enabled: boolean): void {
  setImage('damocles.imageGeneration.enabled', { type: 'setImageGenerationEnabled', enabled }, { enabled });
}

function setImageModel(model: string): void {
  setImage('damocles.imageGeneration.model', { type: 'setImageGenerationModel', model }, { model });
}
</script>

<template>
  <SettingsRow id="damocles.mcp.enabled">
    <SettingSwitch
      :model-value="mcpEnabled"
      :label="t('settingsModal.rows.mcp.label')"
      @update:model-value="setMcp"
    />
  </SettingsRow>
  <template
    v-for="entry in switches"
    :key="entry.id"
  >
    <SettingsRow
      v-if="entry.control.status.value"
      :id="entry.id"
    >
      <SettingSwitch
        :model-value="entry.control.status.value.enabled"
        :label="t(`settingsModal.rows.${entry.name}.label`)"
        @update:model-value="entry.control.set"
      />
    </SettingsRow>
  </template>

  <template v-if="imageGeneration">
    <div
      v-if="!page.query"
      class="sm-group-head"
    >
      {{ t('settingsModal.groups.imageGeneration') }}
    </div>
    <SettingsRow
      id="damocles.imageGeneration.enabled"
      :description="imageGeneration.openRouterConfigured ? undefined : t('settingsModal.imageNeedsKey')"
    >
      <SettingSwitch
        :model-value="imageGeneration.enabled"
        :label="t('settingsModal.rows.imageGeneration.label')"
        @update:model-value="setImageEnabled"
      />
    </SettingsRow>
    <SettingsRow
      id="damocles.imageGeneration.model"
      :description="imageModelUnknown ? t('settings.imageGeneration.unknownModel', { model: imageGeneration.model }) : undefined"
    >
      <SettingSelect
        :model-value="imageGeneration.model"
        :options="imageModelOptions"
        :placeholder="t('settings.imageGeneration.modelPlaceholder')"
        :label="t('settingsModal.rows.imageModel.label')"
        @update:model-value="setImageModel"
      />
    </SettingsRow>
  </template>
</template>
