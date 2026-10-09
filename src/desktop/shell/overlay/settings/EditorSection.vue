<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingInput from '@/components/settings/controls/SettingInput.vue';
import SettingSelect, { type SelectOption } from '@/components/settings/controls/SettingSelect.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import {
  DESKTOP_CONFIGURATION,
  EDITOR_AUTO_SAVE_SETTING,
  EDITOR_AUTO_SAVES,
  EDITOR_DETECT_INDENTATION_SETTING,
  EDITOR_FONT_SIZE_SETTING,
  EDITOR_FORMAT_ON_SAVE_SETTING,
  EDITOR_MINIMAP_SETTING,
  EDITOR_RENDER_WHITESPACE_SETTING,
  EDITOR_RENDER_WHITESPACES,
  EDITOR_TAB_SIZE_SETTING,
  EDITOR_WORD_WRAP_SETTING,
} from '../../../main/desktop-configuration';
import { useDesktopPrefs } from './desktop-prefs';
import { integerSetting } from './integer-setting';

type AutoSave = (typeof EDITOR_AUTO_SAVES)[number];
type RenderWhitespace = (typeof EDITOR_RENDER_WHITESPACES)[number];

// D25: the desktop editor's settings with VS Code's defaults, applied live to every open editor (main republishes them).
const { t } = useI18n();
const prefs = useDesktopPrefs();

// The value main read, else the declared default; main validated it against the declaration on write.
const valueOf = (key: string): unknown => prefs.values.value[key] ?? DESKTOP_CONFIGURATION[key]?.default;
const fontSize = computed(() => String(valueOf(EDITOR_FONT_SIZE_SETTING)));
const tabSize = computed(() => String(valueOf(EDITOR_TAB_SIZE_SETTING)));
const wordWrap = computed(() => (valueOf(EDITOR_WORD_WRAP_SETTING) === 'on' ? 'on' : 'off'));
const renderWhitespace = computed(() => EDITOR_RENDER_WHITESPACES.find((value) => value === valueOf(EDITOR_RENDER_WHITESPACE_SETTING)) ?? 'selection');
const autoSave = computed<AutoSave>(() => EDITOR_AUTO_SAVES.find((value) => value === valueOf(EDITOR_AUTO_SAVE_SETTING)) ?? 'off');

const parseFontSize = integerSetting(EDITOR_FONT_SIZE_SETTING, t);
const parseTabSize = integerSetting(EDITOR_TAB_SIZE_SETTING, t);

const wordWrapOptions = computed(() => [
  { value: 'off' as const, label: t('settingsHost.editor.off') },
  { value: 'on' as const, label: t('settingsHost.editor.on') },
]);
const whitespaceOptions = computed<SelectOption<RenderWhitespace>[]>(() => EDITOR_RENDER_WHITESPACES.map((value) => ({ value, label: t(`settingsHost.editor.whitespace.${value}`) })));
const autoSaveOptions = computed(() => EDITOR_AUTO_SAVES.map((value) => ({ value, label: t(`settingsHost.editor.autoSave.${value}`) })));
</script>

<template>
  <SettingsRow :id="EDITOR_FONT_SIZE_SETTING">
    <SettingInput
      :model-value="fontSize"
      :parse="parseFontSize"
      :label="t('settingsHost.rows.editorFontSize.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(EDITOR_FONT_SIZE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_TAB_SIZE_SETTING">
    <SettingInput
      :model-value="tabSize"
      :parse="parseTabSize"
      :label="t('settingsHost.rows.editorTabSize.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(EDITOR_TAB_SIZE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_DETECT_INDENTATION_SETTING">
    <SettingSwitch
      :model-value="valueOf(EDITOR_DETECT_INDENTATION_SETTING) === true"
      :label="t('settingsHost.rows.editorDetectIndentation.label')"
      @update:model-value="(value) => prefs.set(EDITOR_DETECT_INDENTATION_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_WORD_WRAP_SETTING">
    <SettingSeg
      :model-value="wordWrap"
      :options="wordWrapOptions"
      :label="t('settingsHost.rows.editorWordWrap.label')"
      @update:model-value="(value) => prefs.set(EDITOR_WORD_WRAP_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_MINIMAP_SETTING">
    <SettingSwitch
      :model-value="valueOf(EDITOR_MINIMAP_SETTING) === true"
      :label="t('settingsHost.rows.editorMinimap.label')"
      @update:model-value="(value) => prefs.set(EDITOR_MINIMAP_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_RENDER_WHITESPACE_SETTING">
    <SettingSelect
      :model-value="renderWhitespace"
      :options="whitespaceOptions"
      :label="t('settingsHost.rows.editorRenderWhitespace.label')"
      @update:model-value="(value) => prefs.set(EDITOR_RENDER_WHITESPACE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_AUTO_SAVE_SETTING">
    <SettingSeg
      :model-value="autoSave"
      :options="autoSaveOptions"
      :label="t('settingsHost.rows.editorAutoSave.label')"
      @update:model-value="(value) => prefs.set(EDITOR_AUTO_SAVE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="EDITOR_FORMAT_ON_SAVE_SETTING">
    <SettingSwitch
      :model-value="valueOf(EDITOR_FORMAT_ON_SAVE_SETTING) === true"
      :label="t('settingsHost.rows.editorFormatOnSave.label')"
      @update:model-value="(value) => prefs.set(EDITOR_FORMAT_ON_SAVE_SETTING, value)"
    />
  </SettingsRow>
</template>
