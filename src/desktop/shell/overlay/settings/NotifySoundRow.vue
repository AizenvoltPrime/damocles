<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { useDesktopPrefs } from './desktop-prefs';

const { t } = useI18n();
const prefs = useDesktopPrefs();
// Notify me off mutes every pop-up's sound, so this switch has nothing to turn on then.
const notifyOff = computed(() => prefs.values.value['damocles.desktop.notifications.enabled'] === false);
</script>

<template>
  <SettingsRow id="damocles.desktop.notifications.sound">
    <SettingSwitch
      :model-value="prefs.values.value['damocles.desktop.notifications.sound'] !== false"
      :label="t('settingsHost.rows.notifySound.label')"
      :disabled="notifyOff"
      @update:model-value="(value) => prefs.set('damocles.desktop.notifications.sound', value)"
    />
  </SettingsRow>
</template>
