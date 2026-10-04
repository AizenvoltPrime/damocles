<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { useDesktopPrefs } from './desktop-prefs';

const { t } = useI18n();
const prefs = useDesktopPrefs();
</script>

<template>
  <SettingsRow id="damocles.desktop.notifications.enabled">
    <SettingSwitch
      :model-value="prefs.values.value['damocles.desktop.notifications.enabled'] !== false"
      :label="t('settingsHost.rows.notify.label')"
      @update:model-value="(value) => prefs.set('damocles.desktop.notifications.enabled', value)"
    />
  </SettingsRow>
</template>
