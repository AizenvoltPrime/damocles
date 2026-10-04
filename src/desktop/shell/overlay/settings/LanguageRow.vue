<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import { useSettingsBanner } from '@/components/settings/settings-view';
import { useSettingWritesStore } from '@/components/settings/settings-writes';
import { useDesktopPrefs } from './desktop-prefs';

type Language = 'system' | 'en' | 'el';
const KEY = 'damocles.desktop.language';

const { t } = useI18n();
const prefs = useDesktopPrefs();
const banner = useSettingsBanner();
const writes = useSettingWritesStore();

// Endonyms, so each language is recognizable whatever the UI language is.
const options = computed<{ value: Language; label: string }[]>(() => [
  { value: 'system', label: t('settingsHost.language.system') },
  { value: 'en', label: 'English' },
  { value: 'el', label: 'Ελληνικά' },
]);
const language = computed<Language>(() => {
  const value = prefs.values.value[KEY];
  return value === 'en' || value === 'el' ? value : 'system';
});

// Chromium fixes its UI locale at launch (D23), so a saved language other than the launch one offers a restart.
watch(() => writes.latest([KEY]), (result, previous) => {
  if (result?.kind !== 'saved' || result.seq === previous?.seq) return;
  if (language.value === prefs.languageAtLaunch.value) {
    banner.dismiss();
    return;
  }
  banner.show({
    testId: 'settings-restart-banner',
    text: t('settingsHost.restartBanner'),
    actions: [
      { label: t('settingsHost.restartNow'), primary: true, run: () => void prefs.api.relaunch() },
      { label: t('settingsHost.later'), run: () => banner.dismiss() },
    ],
  });
});
</script>

<template>
  <SettingsRow id="damocles.desktop.language">
    <SettingSeg
      :model-value="language"
      :options="options"
      :label="t('settingsHost.rows.language.label')"
      @update:model-value="(value) => prefs.set(KEY, value)"
    />
  </SettingsRow>
</template>
