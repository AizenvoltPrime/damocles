<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { useToolGroupSwitch } from '@/components/settings/tool-groups';
import {
  DESKTOP_CONFIGURATION,
  FORGE_AGENT_READ_ANY_REPOSITORY_SETTING,
  FORGE_AGENT_TOOLS_SETTING,
  FORGE_BRANCH_PROTECTION_SETTING,
  FORGE_CI_STATUS_SETTING,
  FORGE_CLONE_PROTOCOL_SETTING,
  FORGE_SHOW_AVATARS_SETTING,
} from '../../../local-services/desktop-configuration';
import { useDesktopPrefs } from './desktop-prefs';

// The damocles.desktop.forge.* rows at the end of Accounts' Git hosting group, in OverlaySettings' FORGE_SETTINGS order.
const { t } = useI18n();
const prefs = useDesktopPrefs();
// The agent tools switch is the Tools panel's forge switch: core's toolStatus is its value and toggleToolGroup its write.
const agentTools = useToolGroupSwitch('forge');

const valueOf = (key: string): unknown => prefs.values.value[key] ?? DESKTOP_CONFIGURATION[key]?.default;
const PROTOCOLS = ['https', 'ssh'] as const;
const protocol = computed(() => PROTOCOLS.find((value) => value === valueOf(FORGE_CLONE_PROTOCOL_SETTING)) ?? 'https');
// protocol names, which no locale translates
const protocolOptions = PROTOCOLS.map((value) => ({ value, label: value.toUpperCase() }));

const SWITCHES = [
  [FORGE_CI_STATUS_SETTING, 'forgeCiStatus'],
  [FORGE_BRANCH_PROTECTION_SETTING, 'forgeBranchProtection'],
] as const;
</script>

<template>
  <template v-if="agentTools.status.value">
    <SettingsRow :id="FORGE_AGENT_TOOLS_SETTING">
      <SettingSwitch
        :model-value="agentTools.status.value.enabled"
        :label="t('settingsHost.rows.forgeAgentTools.label')"
        @update:model-value="agentTools.set"
      />
    </SettingsRow>
    <SettingsRow
      v-if="agentTools.status.value.enabled"
      :id="FORGE_AGENT_READ_ANY_REPOSITORY_SETTING"
    >
      <SettingSwitch
        :model-value="valueOf(FORGE_AGENT_READ_ANY_REPOSITORY_SETTING) === true"
        :label="t('settingsHost.rows.forgeAgentReadAnyRepository.label')"
        @update:model-value="(value) => prefs.set(FORGE_AGENT_READ_ANY_REPOSITORY_SETTING, value)"
      />
    </SettingsRow>
  </template>
  <SettingsRow
    v-for="[key, name] in SWITCHES"
    :id="key"
    :key="key"
  >
    <SettingSwitch
      :model-value="valueOf(key) === true"
      :label="t(`settingsHost.rows.${name}.label`)"
      @update:model-value="(value) => prefs.set(key, value)"
    />
  </SettingsRow>
  <SettingsRow :id="FORGE_CLONE_PROTOCOL_SETTING">
    <SettingSeg
      :model-value="protocol"
      :options="protocolOptions"
      :label="t('settingsHost.rows.forgeCloneProtocol.label')"
      @update:model-value="(value) => prefs.set(FORGE_CLONE_PROTOCOL_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="FORGE_SHOW_AVATARS_SETTING">
    <SettingSwitch
      :model-value="valueOf(FORGE_SHOW_AVATARS_SETTING) === true"
      :label="t('settingsHost.rows.forgeShowAvatars.label')"
      @update:model-value="(value) => prefs.set(FORGE_SHOW_AVATARS_SETTING, value)"
    />
  </SettingsRow>
</template>
