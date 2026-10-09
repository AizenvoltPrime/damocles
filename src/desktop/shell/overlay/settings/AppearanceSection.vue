<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RotateCcw } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { useSettingsPage } from '@/components/settings/settings-view';
import { useDesktopPrefs } from './desktop-prefs';

type Theme = 'dark' | 'light' | 'system';

const { t } = useI18n();
const page = useSettingsPage();
const prefs = useDesktopPrefs();

const themeOptions = computed<{ value: Theme; label: string }[]>(() => [
  { value: 'dark', label: t('settingsHost.theme.dark') },
  { value: 'light', label: t('settingsHost.theme.light') },
  { value: 'system', label: t('settingsHost.theme.system') },
]);
const theme = computed<Theme>(() => {
  const value = prefs.values.value['damocles.desktop.theme'];
  return value === 'dark' || value === 'light' ? value : 'system';
});

const resetting = ref(false);
const resetError = ref<string | null>(null);
const resetDone = ref(false);

async function resetLayout(): Promise<void> {
  resetting.value = true;
  resetError.value = null;
  resetDone.value = false;
  try {
    await prefs.api.resetLayout();
    resetDone.value = true;
  } catch (error) {
    resetError.value = error instanceof Error ? error.message : String(error);
  } finally {
    resetting.value = false;
  }
}
</script>

<template>
  <SettingsRow id="damocles.desktop.theme">
    <SettingSeg
      :model-value="theme"
      :options="themeOptions"
      :label="t('settingsHost.rows.theme.label')"
      @update:model-value="(value) => prefs.set('damocles.desktop.theme', value)"
    />
  </SettingsRow>
  <SettingsRow id="damocles.desktop.reduceMotion">
    <SettingSwitch
      :model-value="prefs.values.value['damocles.desktop.reduceMotion'] === true"
      :label="t('settingsHost.rows.reduceMotion.label')"
      @update:model-value="(value) => prefs.set('damocles.desktop.reduceMotion', value)"
    />
  </SettingsRow>
  <div
    v-if="!page.query"
    class="sm-group-head"
  >
    {{ t('settingsHost.groups.layout') }}
  </div>
  <SettingsRow id="damocles.desktop.restoreLayout">
    <SettingSwitch
      :model-value="prefs.values.value['damocles.desktop.restoreLayout'] !== false"
      :label="t('settingsHost.rows.restoreLayout.label')"
      @update:model-value="(value) => prefs.set('damocles.desktop.restoreLayout', value)"
    />
  </SettingsRow>
  <SettingsRow
    id="restore-default-layout"
    :description="resetError ?? (resetDone ? t('settingsHost.layoutRestored') : undefined)"
  >
    <SettingButton
      :disabled="resetting"
      @click="resetLayout"
    >
      <RotateCcw
        class="size-3"
        aria-hidden="true"
      />
      {{ t('settingsHost.restoreDefaults') }}
    </SettingButton>
  </SettingsRow>
</template>
