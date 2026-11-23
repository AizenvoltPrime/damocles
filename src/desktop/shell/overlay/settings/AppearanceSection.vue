<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronLeft, RotateCcw } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingSlider from '@/components/settings/controls/SettingSlider.vue';
import { useSettingsPage } from '@/components/settings/settings-view';
import { parseTextSize, TEXT_SIZE_RANGE } from '@shared/themes/style';
import { THEME_APPLY_MODES, type ThemeApplyMode } from '@shared/themes/agent';
import {
  FILE_ICON_THEME_SETTING, type FileIconTheme, parseFileIconTheme, SHOW_WALLPAPERS_SETTING, SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING, TEXT_SIZE_SETTING, THEMES_AGENT_TOOLS_SETTING, THEMES_APPLY_MODE_SETTING,
  WALLPAPER_CONTRAST_MODES, WALLPAPER_CONTRAST_SETTING, CHARACTER_MOTION_SETTING, CHARACTER_MOTIONS, THEMES_STORE_SETTING,
} from '../../../local-services/desktop-configuration';
import { ran } from '../popup-answer';
import { useDesktopPrefs } from './desktop-prefs';
import ThemeGallery from './themes/ThemeGallery.vue';
import ScheduleEditor from './themes/ScheduleEditor.vue';

const { t } = useI18n();
const page = useSettingsPage();
const prefs = useDesktopPrefs();

const fileIconThemeOptions = computed<{ value: FileIconTheme; label: string }[]>(() => [
  { value: 'material', label: t('settingsHost.fileIconTheme.material') },
  { value: 'minimal', label: t('settingsHost.fileIconTheme.minimal') },
]);
const fileIconTheme = computed(() => parseFileIconTheme(prefs.values.value[FILE_ICON_THEME_SETTING]));
const textSize = computed(() => parseTextSize(prefs.values.value[TEXT_SIZE_SETTING]));
const applyModeOptions = computed<{ value: ThemeApplyMode; label: string }[]>(() => THEME_APPLY_MODES.map((value) => ({ value, label: t(`settingsHost.rows.themesApplyMode.${value}`) })));
const applyMode = computed<ThemeApplyMode>(() => {
  const value = prefs.values.value[THEMES_APPLY_MODE_SETTING];
  return THEME_APPLY_MODES.find((mode) => mode === value) ?? 'preview';
});

type WallpaperContrast = (typeof WALLPAPER_CONTRAST_MODES)[number];
const wallpaperContrastOptions = computed<{ value: WallpaperContrast; label: string }[]>(() => WALLPAPER_CONTRAST_MODES.map((value) => ({ value, label: t(`settingsHost.rows.wallpaperContrast.${value}`) })));
const wallpaperContrast = computed<WallpaperContrast>(() => (prefs.values.value[WALLPAPER_CONTRAST_SETTING] === 'warn' ? 'warn' : 'raiseDim'));

type CharacterMotion = (typeof CHARACTER_MOTIONS)[number];
const characterMotionOptions = computed<{ value: CharacterMotion; label: string }[]>(() => CHARACTER_MOTIONS.map((value) => ({ value, label: t(`settingsHost.rows.characterMotion.${value}`) })));
const characterMotion = computed<CharacterMotion>(() => CHARACTER_MOTIONS.find((value) => value === prefs.values.value[CHARACTER_MOTION_SETTING]) ?? 'always');

// The theme schedule is a sub-page of Appearance, which the modal's navigation holds: a click from a search reaches it,
// and a search, another section or another scope tab ends it.
const SCHEDULE_PAGE = 'schedule';
const schedulePage = computed(() => page.subPage === SCHEDULE_PAGE);
const scheduleHeading = ref<HTMLElement | null>(null);
const gallery = ref<InstanceType<typeof ThemeGallery> | null>(null);
watch(scheduleHeading, (heading) => heading?.focus(), { flush: 'post' });
async function closeSchedule(): Promise<void> {
  page.openSubPage('appearance', undefined);
  await nextTick();
  gallery.value?.focusScheduleEdit();
}

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
  <div
    v-if="schedulePage"
    class="flex flex-col gap-2"
    data-testid="schedule-page"
  >
    <!-- a link back to the section, so it is not drawn as a settings button -->
    <button
      type="button"
      class="inline-flex w-fit items-center gap-1 rounded-6 px-1 text-12 text-(--d-accent-text) hover:bg-(--d-hover)"
      :aria-label="t('settingsHost.schedule.backLabel')"
      data-testid="schedule-back"
      @click="closeSchedule"
    >
      <ChevronLeft
        class="size-3.5"
        aria-hidden="true"
      />{{ t('settingsHost.schedule.back') }}
    </button>
    <h2
      ref="scheduleHeading"
      tabindex="-1"
      class="text-15 font-semibold"
    >
      {{ t('settingsHost.schedule.title') }}
    </h2>
    <ScheduleEditor @back="closeSchedule" />
  </div>
  <template v-else>
    <div
      v-if="!page.query"
      class="sm-group-head"
    >
      {{ t('settingsHost.groups.themes') }}
    </div>
    <ThemeGallery
      ref="gallery"
      @edit-schedule="page.openSubPage('appearance', SCHEDULE_PAGE)"
    />
    <SettingsRow :id="TEXT_SIZE_SETTING">
      <SettingSlider
        :model-value="textSize"
        :min="TEXT_SIZE_RANGE.min"
        :max="TEXT_SIZE_RANGE.max"
        :label="t('settingsHost.rows.textSize.label')"
        :format="(value: number) => `${value} px`"
        @update:model-value="(value: number) => prefs.set(TEXT_SIZE_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="THEMES_APPLY_MODE_SETTING">
      <SettingSeg
        :model-value="applyMode"
        :options="applyModeOptions"
        :label="t('settingsHost.rows.themesApplyMode.label')"
        @update:model-value="(value) => prefs.set(THEMES_APPLY_MODE_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="THEMES_AGENT_TOOLS_SETTING">
      <SettingSwitch
        :model-value="prefs.values.value[THEMES_AGENT_TOOLS_SETTING] !== false"
        :label="t('settingsHost.rows.themesAgentTools.label')"
        @update:model-value="(value) => prefs.set(THEMES_AGENT_TOOLS_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="SHOW_WALLPAPERS_SETTING">
      <SettingSwitch
        :model-value="prefs.values.value[SHOW_WALLPAPERS_SETTING] !== false"
        :label="t('settingsHost.rows.showWallpapers.label')"
        @update:model-value="(value) => prefs.set(SHOW_WALLPAPERS_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="WALLPAPER_CONTRAST_SETTING">
      <SettingSeg
        :model-value="wallpaperContrast"
        :options="wallpaperContrastOptions"
        :label="t('settingsHost.rows.wallpaperContrast.label')"
        @update:model-value="(value) => prefs.set(WALLPAPER_CONTRAST_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="CHARACTER_MOTION_SETTING">
      <SettingSeg
        :model-value="characterMotion"
        :options="characterMotionOptions"
        :label="t('settingsHost.rows.characterMotion.label')"
        @update:model-value="(value) => prefs.set(CHARACTER_MOTION_SETTING, value)"
      />
    </SettingsRow>
    <SettingsRow :id="THEMES_STORE_SETTING">
      <SettingSwitch
        :model-value="prefs.values.value[THEMES_STORE_SETTING] !== false"
        :label="t('settingsHost.rows.themesStore.label')"
        @update:model-value="(value) => prefs.set(THEMES_STORE_SETTING, value)"
      />
    </SettingsRow>
    <div
      v-if="!page.query"
      class="sm-group-head"
    >
      {{ t('settingsHost.groups.iconsAndMotion') }}
    </div>
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
</template>
