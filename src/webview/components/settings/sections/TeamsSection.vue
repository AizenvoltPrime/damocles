<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { EffortLevel, ExtensionSettings, TeamRole } from '@shared/types/settings';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingsRow from '../SettingsRow.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { useSettingWrite } from '../settings-writes';
import { useToolGroupSwitch } from '../tool-groups';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { currentSettings, availableModels, activeModel } = storeToRefs(settingsStore);
const write = useSettingWrite();
const teamGroup = useToolGroupSwitch('team');

// reka reserves '' for "no selection"; an unset role slot is '' (model) or null (effort) in the settings.
const UNSET = '__default__';

type TeamSettings = ExtensionSettings['team'];
const ROLES: { role: TeamRole; id: string; model: keyof TeamSettings; effort: keyof TeamSettings }[] = [
  { role: 'lead', id: 'damocles.team.leadModel', model: 'leadModel', effort: 'leadEffort' },
  { role: 'implementor', id: 'damocles.team.implementorModel', model: 'implementorModel', effort: 'implementorEffort' },
  { role: 'reviewer', id: 'damocles.team.reviewerModel', model: 'reviewerModel', effort: 'reviewerEffort' },
];

const modelChoices = computed(() => [
  { value: UNSET, label: t('settings.teamModelDefault') },
  ...availableModels.value.map((model) => ({ value: model.value, label: model.displayName })),
]);

function effortChoices(role: (typeof ROLES)[number]) {
  const configured = currentSettings.value.team[role.model] as string;
  const model = configured !== '' ? configured : activeModel.value;
  const levels = availableModels.value.find((candidate) => candidate.value === model)?.supportedEffortLevels ?? [];
  return [
    { value: UNSET, label: t('settings.teamEffortDefault') },
    ...levels.map((level) => ({ value: level as string, label: t(`settingsModal.effort.${level}`) })),
  ];
}

// The revert puts back only this field, so it never undoes another team row's write.
function setTeamField(field: keyof TeamSettings, value: TeamSettings[keyof TeamSettings], key: string, message: Parameters<typeof write>[1]): void {
  const before = currentSettings.value.team[field];
  write(key, message, {
    apply: () => settingsStore.setTeamSettings({ ...currentSettings.value.team, [field]: value }),
    revert: () => settingsStore.setTeamSettings({ ...currentSettings.value.team, [field]: before }),
  });
}

function setRoleModel(role: (typeof ROLES)[number], value: string): void {
  const model = value === UNSET ? '' : value;
  setTeamField(role.model, model, `damocles.team.${role.role}Model`, { type: 'setTeamRoleModel', role: role.role, model });
}

function setRoleEffort(role: (typeof ROLES)[number], value: string): void {
  const effort = value === UNSET ? null : (value as EffortLevel);
  setTeamField(role.effort, effort, `damocles.team.${role.role}Effort`, { type: 'setTeamRoleEffort', role: role.role, effort });
}
</script>

<template>
  <SettingsRow
    v-if="teamGroup.status.value"
    id="damocles.team.enabled"
  >
    <SettingSwitch
      :model-value="teamGroup.status.value.enabled"
      :label="t('settingsModal.rows.teamEnabled.label')"
      @update:model-value="teamGroup.set"
    />
  </SettingsRow>
  <SettingsRow
    v-for="role in ROLES"
    :id="role.id"
    :key="role.role"
  >
    <SettingSelect
      :model-value="(currentSettings.team[role.model] as string) || UNSET"
      :options="modelChoices"
      :label="t(`settingsModal.rows.team${role.role[0]!.toUpperCase()}${role.role.slice(1)}.label`)"
      @update:model-value="(value) => setRoleModel(role, value)"
    />
    <SettingSelect
      v-if="effortChoices(role).length > 1"
      :model-value="(currentSettings.team[role.effort] as string | null) ?? UNSET"
      :options="effortChoices(role)"
      :label="t('settingsModal.rows.teamEffort.label', { role: t(`settingsModal.rows.team${role.role[0]!.toUpperCase()}${role.role.slice(1)}.label`) })"
      @update:model-value="(value) => setRoleEffort(role, value)"
    />
  </SettingsRow>
</template>
