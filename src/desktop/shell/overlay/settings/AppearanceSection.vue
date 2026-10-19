<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RotateCcw } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { useSettingsPage } from '@/components/settings/settings-view';
import { FILE_ICON_THEME_SETTING, type FileIconTheme, parseFileIconTheme, SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING } from '../../../main/desktop-configuration';
import { ran } from '../popup-answer';
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

const fileIconThemeOptions = computed<{ value: FileIconTheme; label: string }[]>(() => [
  { value: 'material', label: t('settingsHost.fileIconTheme.material') },
  { value: 'minimal', label: t('settingsHost.fileIconTheme.minimal') },
]);
const fileIconTheme = computed(() => parseFileIconTheme(prefs.values.value[FILE_ICON_THEME_SETTING]));

const resetting = ref(false);
const resetOutcome = ref<'done' | 'failed' | null>(null);
const resetFeedback = computed(() => {
  if (resetOutcome.value === 'done') return t('settingsHost.layoutRestored');
  return resetOutcome.value === 'failed' ? t('settingsHost.layoutResetFailed') : undefined;
});

async function resetLayout(): Promise<void> {
  resetting.value = true;
  resetOutcome.value = null;
  try {
    if (await ran(prefs.api.resetLayout())) resetOutcome.value = 'done';
  } catch {
    resetOutcome.value = 'failed';
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
  <SettingsRow :id="FILE_ICON_THEME_SETTING">
    <SettingSeg
      :model-value="fileIconTheme"
      :options="fileIconThemeOptions"
      :label="t('settingsHost.rows.fileIconTheme.label')"
      @update:model-value="(value) => prefs.set(FILE_ICON_THEME_SETTING, value)"
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
  <SettingsRow :id="SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING">
    <SettingSwitch
      :model-value="prefs.values.value[SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING] === true"
      :label="t('settingsHost.rows.alwaysShowHeaderActions.label')"
      @update:model-value="(value) => prefs.set(SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    id="restore-default-layout"
    :description="resetFeedback"
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
