<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CircleCheck, EyeOff, FileJson } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingInput, { type InputParse } from '@/components/settings/controls/SettingInput.vue';
import SettingSelect, { type SelectOption } from '@/components/settings/controls/SettingSelect.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSlider from '@/components/settings/controls/SettingSlider.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { MAX_USER_TERMINAL_PROFILES, TERMINAL_CURSOR_STYLES, type TerminalCursorStyle, type TerminalProfileReport } from '../../../preload/terminal-channels';
import { terminalGlyph } from '../../terminal/terminal-icons';
import { isFontList } from '../../terminal/terminal-options';
import {
  DESKTOP_CONFIGURATION,
  TERMINAL_CONFIRM_ON_KILL_SETTING,
  TERMINAL_CONFIRM_ON_KILL_VALUES,
  TERMINAL_CURSOR_BLINKING_SETTING,
  TERMINAL_CURSOR_STYLE_SETTING,
  TERMINAL_DECORATIONS_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_FONT_FAMILY_SETTING,
  TERMINAL_FONT_SIZE_SETTING,
  TERMINAL_LINE_HEIGHT_SETTING,
  TERMINAL_MAC_OPTION_IS_META_SETTING,
  TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING,
  TERMINAL_MULTI_LINE_PASTE_WARNINGS,
  TERMINAL_PROFILES_SETTING,
  TERMINAL_SCROLLBACK_SETTING,
  TERMINAL_SHELL_INTEGRATION_SETTING,
  type TerminalConfirmOnKill,
  type TerminalMultiLinePasteWarning,
} from '../../../main/desktop-configuration';
import { useDesktopPrefs } from './desktop-prefs';
import { integerSetting } from './integer-setting';
import { EDIT_SETTINGS_FILE } from './settings-file-link';

// D25: the desktop terminal's settings with VS Code's defaults, applied live to every open terminal (main republishes them).
const { t } = useI18n();
const prefs = useDesktopPrefs();
const editSettingsFile = inject(EDIT_SETTINGS_FILE)!;

// reka's select reserves '' for no selection, so the setting's '' (the first detected shell) has a sentinel of its own.
const FIRST_DETECTED = '<first>';
// Main's validated profiles, the detected names a null entry hides and the entries it refused; it pushes a new report
// whenever it validates the setting again.
const report = shallowRef<TerminalProfileReport>({ profiles: [], hidden: [], problems: [] });
const profiles = computed(() => report.value.profiles);
const userProfiles = computed(() => profiles.value.filter((profile) => profile.source === 'user'));
const detectedProfiles = computed(() => profiles.value.filter((profile) => profile.source === 'detected'));
let pushed = false;
const stopReport = prefs.api.onTerminalProfiles((next) => {
  pushed = true;
  report.value = next;
});
onBeforeUnmount(stopReport);
onMounted(async () => {
  const first = await prefs.api.getTerminalProfiles();
  if (!pushed) report.value = first;
});

// The value main read, else the declared default; main validated it against the declaration on write.
const valueOf = (key: string): unknown => prefs.values.value[key] ?? DESKTOP_CONFIGURATION[key]?.default;
const fontSize = computed(() => String(valueOf(TERMINAL_FONT_SIZE_SETTING)));
const scrollback = computed(() => String(valueOf(TERMINAL_SCROLLBACK_SETTING)));
const fontFamily = computed(() => String(valueOf(TERMINAL_FONT_FAMILY_SETTING) ?? ''));
const lineHeight = computed(() => Number(valueOf(TERMINAL_LINE_HEIGHT_SETTING)));
const cursorBlinking = computed(() => valueOf(TERMINAL_CURSOR_BLINKING_SETTING) === true);
const macOptionIsMeta = computed(() => valueOf(TERMINAL_MAC_OPTION_IS_META_SETTING) === true);
const pasteWarning = computed<TerminalMultiLinePasteWarning>(() => TERMINAL_MULTI_LINE_PASTE_WARNINGS.find((value) => value === valueOf(TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING)) ?? 'auto');
const shellIntegration = computed(() => valueOf(TERMINAL_SHELL_INTEGRATION_SETTING) === true);
const decorations = computed(() => valueOf(TERMINAL_DECORATIONS_SETTING) === true);
const confirmOnKill = computed<TerminalConfirmOnKill>(() => TERMINAL_CONFIRM_ON_KILL_VALUES.find((value) => value === valueOf(TERMINAL_CONFIRM_ON_KILL_SETTING)) ?? 'running');
const lineHeightRange = DESKTOP_CONFIGURATION[TERMINAL_LINE_HEIGHT_SETTING]!;
const cursorStyle = computed<TerminalCursorStyle>(() => TERMINAL_CURSOR_STYLES.find((value) => value === valueOf(TERMINAL_CURSOR_STYLE_SETTING)) ?? 'block');
const defaultProfile = computed(() => {
  const value = valueOf(TERMINAL_DEFAULT_PROFILE_SETTING);
  return typeof value === 'string' && value !== '' ? value : FIRST_DETECTED;
});

const profileOptions = computed<SelectOption<string>[]>(() => {
  const first = profiles.value[0];
  const options: SelectOption<string>[] = [
    { value: FIRST_DETECTED, label: first ? t('settingsHost.terminal.firstDetectedNamed', { name: first.name }) : t('settingsHost.terminal.firstDetected') },
    ...profiles.value.map((profile) => ({ value: profile.id, label: profile.name, hint: profile.path })),
  ];
  // A saved profile this machine did not detect still shows, so the select never reads as unset.
  const saved = defaultProfile.value;
  if (saved !== FIRST_DETECTED && !profiles.value.some((profile) => profile.id === saved)) {
    options.push({ value: saved, label: t('settingsHost.terminal.missingProfile', { id: saved }), disabled: true });
  }
  return options;
});

function problemName(name: string | null): string {
  return name ?? TERMINAL_PROFILES_SETTING;
}

const cursorOptions = computed(() => TERMINAL_CURSOR_STYLES.map((value) => ({ value, label: t(`settingsHost.terminal.cursor.${value}`) })));
const pasteWarningOptions = computed(() => TERMINAL_MULTI_LINE_PASTE_WARNINGS.map((value) => ({ value, label: t(`settingsHost.terminal.pasteWarning.${value}`) })));
const confirmOnKillOptions = computed(() => TERMINAL_CONFIRM_ON_KILL_VALUES.map((value) => ({ value, label: t(`settingsHost.terminal.confirmOnKill.${value}`) })));

// An empty family is the app's monospace font; a value that is no font list is refused here, and the terminal ignores one
// written to the settings file by hand.
const parseFontFamily: InputParse<string> = (raw) => {
  const value = raw.trim();
  return value === '' || isFontList(value, (property, css) => CSS.supports(property, css)) ? { ok: true, value } : { ok: false, error: t('settingsHost.terminal.fontFamilyInvalid') };
};
</script>

<template>
  <SettingsRow :id="TERMINAL_DEFAULT_PROFILE_SETTING">
    <SettingSelect
      :model-value="defaultProfile"
      :options="profileOptions"
      :label="t('settingsHost.rows.terminalDefaultProfile.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_DEFAULT_PROFILE_SETTING, value === FIRST_DETECTED ? '' : value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_PROFILES_SETTING">
    <SettingButton
      data-testid="terminal-profiles-edit"
      @click="editSettingsFile('user', TERMINAL_PROFILES_SETTING)"
    >
      <FileJson
        class="size-3"
        aria-hidden="true"
      />
      {{ t('settingsHost.editInSettingsJson') }}
    </SettingButton>
    <template #expand>
      <div
        class="sm-row-block flex flex-col gap-3"
        data-testid="terminal-profiles"
      >
        <section :aria-label="t('settingsHost.terminal.profiles.user')">
          <h4 class="mb-1.5 text-10.5 font-semibold tracking-[.07em] text-(--d-muted) uppercase">
            {{ t('settingsHost.terminal.profiles.user') }}
          </h4>
          <Card class="overflow-hidden rounded-lg border-(--d-border) bg-(--d-card) shadow-none">
            <ul
              v-if="userProfiles.length > 0"
              class="divide-y divide-(--d-border)"
            >
              <li
                v-for="profile in userProfiles"
                :key="profile.id"
                data-testid="terminal-profile"
                :data-profile-id="profile.id"
                :data-source="profile.source"
                class="flex items-start gap-2.5 px-3 py-2"
              >
                <component
                  :is="terminalGlyph(profile).icon"
                  aria-hidden="true"
                  data-testid="terminal-profile-icon"
                  :data-glyph="profile.customIcon ?? profile.icon"
                  class="mt-0.5 size-3.5 shrink-0"
                  :style="{ color: terminalGlyph(profile).color }"
                />
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <span
                      data-testid="terminal-profile-name"
                      class="truncate text-12.5 font-medium text-(--d-text)"
                    >{{ profile.name }}</span>
                    <Badge
                      v-if="profile.isDefault"
                      variant="tone"
                      class="shrink-0 rounded-5 border-0 bg-(--d-accent-soft) px-1.5 py-px text-10.5 font-normal text-(--d-accent-text)"
                    >
                      {{ t('settingsHost.terminal.profiles.default') }}
                    </Badge>
                  </div>
                  <span
                    data-testid="terminal-profile-path"
                    class="truncate font-mono text-11 text-(--d-muted)"
                    :title="profile.path"
                  >{{ profile.path }}</span>
                  <ul
                    v-if="profile.args.length > 0"
                    class="flex flex-wrap gap-1"
                    :aria-label="t('settingsHost.terminal.profiles.args')"
                  >
                    <li
                      v-for="(arg, index) in profile.args"
                      :key="index"
                      data-testid="terminal-profile-arg"
                      class="max-w-full truncate rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-10.5 text-(--d-text)"
                      :title="arg"
                    >
                      {{ arg }}
                    </li>
                  </ul>
                </div>
              </li>
            </ul>
            <p
              v-else
              data-testid="terminal-profiles-none"
              class="px-3 py-2.5 text-12 text-(--d-muted)"
            >
              {{ t('settingsHost.terminal.profiles.none') }}
            </p>
          </Card>
        </section>
        <section :aria-label="t('settingsHost.terminal.profiles.detected')">
          <h4 class="mb-1.5 text-10.5 font-semibold tracking-[.07em] text-(--d-muted) uppercase">
            {{ t('settingsHost.terminal.profiles.detected') }}
          </h4>
          <Card class="overflow-hidden rounded-lg border-(--d-border) bg-(--d-card) shadow-none">
            <ul class="divide-y divide-(--d-border)">
              <li
                v-for="profile in detectedProfiles"
                :key="profile.id"
                data-testid="terminal-profile"
                :data-profile-id="profile.id"
                :data-source="profile.source"
                class="flex items-center gap-2.5 px-3 py-1.75"
              >
                <component
                  :is="terminalGlyph(profile).icon"
                  aria-hidden="true"
                  data-testid="terminal-profile-icon"
                  :data-glyph="profile.icon"
                  class="size-3.5 shrink-0"
                  :style="{ color: terminalGlyph(profile).color }"
                />
                <span
                  data-testid="terminal-profile-name"
                  class="shrink-0 text-12.5 text-(--d-text)"
                >{{ profile.name }}</span>
                <Badge
                  v-if="profile.isDefault"
                  variant="tone"
                  class="shrink-0 rounded-5 border-0 bg-(--d-accent-soft) px-1.5 py-px text-10.5 font-normal text-(--d-accent-text)"
                >
                  {{ t('settingsHost.terminal.profiles.default') }}
                </Badge>
                <span
                  data-testid="terminal-profile-path"
                  class="min-w-0 flex-1 truncate text-right font-mono text-11 text-(--d-muted)"
                  :title="profile.path"
                >{{ profile.path }}</span>
              </li>
              <li
                v-for="name in report.hidden"
                :key="`hidden:${name}`"
                data-testid="terminal-profile-hidden"
                class="flex items-center gap-2.5 px-3 py-1.75"
                :title="t('settingsHost.terminal.profiles.hiddenHint')"
              >
                <EyeOff
                  aria-hidden="true"
                  class="size-3.5 shrink-0 text-(--d-faint)"
                />
                <span
                  data-testid="terminal-profile-name"
                  class="min-w-0 flex-1 truncate text-12.5 text-(--d-muted)"
                >{{ name }}</span>
                <Badge
                  variant="tone"
                  class="shrink-0 rounded-5 border-0 bg-(--d-hover) px-1.5 py-px text-10.5 font-normal text-(--d-faint-text)"
                >
                  {{ t('settingsHost.terminal.profiles.hidden') }}
                </Badge>
              </li>
            </ul>
          </Card>
        </section>
        <section :aria-label="t('settingsHost.terminal.profiles.problems')">
          <h4 class="mb-1.5 text-10.5 font-semibold tracking-[.07em] text-(--d-muted) uppercase">
            {{ t('settingsHost.terminal.profiles.problems') }}
          </h4>
          <!-- No shadcn Alert part exists in components/ui; a danger-tinted card lists each refused entry. -->
          <Card
            v-if="report.problems.length > 0"
            class="overflow-hidden rounded-lg border-[color-mix(in_srgb,var(--d-danger)_35%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-danger)_7%,var(--d-card))] shadow-none"
          >
            <ul>
              <li
                v-for="(problem, index) in report.problems"
                :key="`${index}:${problem.name ?? ''}:${problem.reason}`"
                data-testid="terminal-profile-problem"
                :data-reason="problem.reason"
                class="flex items-start gap-2.5 px-3 py-2 not-first:border-t not-first:border-[color-mix(in_srgb,var(--d-danger)_20%,var(--d-border))]"
              >
                <CircleAlert
                  aria-hidden="true"
                  class="mt-0.5 size-3.5 shrink-0 text-(--d-danger-text)"
                />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    data-testid="terminal-profile-problem-name"
                    class="truncate text-12.5 font-medium text-(--d-text)"
                    :class="{ 'font-mono text-11.5': problem.name === null }"
                  >{{ problemName(problem.name) }}</span>
                  <span
                    data-testid="terminal-profile-problem-reason"
                    class="text-12 text-(--d-danger-text)"
                  >{{ t(`settingsHost.terminal.problem.${problem.reason}`, { max: MAX_USER_TERMINAL_PROFILES }) }}</span>
                  <span
                    v-if="problem.detail !== null"
                    data-testid="terminal-profile-problem-detail"
                    class="max-w-full self-start truncate rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-10.5 text-(--d-text)"
                    :title="problem.detail"
                  >{{ problem.detail }}</span>
                </div>
              </li>
            </ul>
          </Card>
          <p
            v-else
            data-testid="terminal-profiles-no-problems"
            class="flex items-center gap-1.5 text-12 text-(--d-muted)"
          >
            <CircleCheck
              aria-hidden="true"
              class="size-3.5 text-(--d-success-text)"
            />
            {{ t('settingsHost.terminal.profiles.noProblems') }}
          </p>
        </section>
      </div>
    </template>
  </SettingsRow>
  <SettingsRow :id="TERMINAL_FONT_SIZE_SETTING">
    <SettingInput
      :model-value="fontSize"
      :parse="integerSetting(TERMINAL_FONT_SIZE_SETTING, t)"
      :label="t('settingsHost.rows.terminalFontSize.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(TERMINAL_FONT_SIZE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_FONT_FAMILY_SETTING">
    <SettingInput
      :model-value="fontFamily"
      :parse="parseFontFamily"
      :label="t('settingsHost.rows.terminalFontFamily.label')"
      :placeholder="t('settingsHost.terminal.fontFamilyPlaceholder')"
      @commit="(value: string) => prefs.set(TERMINAL_FONT_FAMILY_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_LINE_HEIGHT_SETTING">
    <SettingSlider
      :model-value="lineHeight"
      :min="lineHeightRange.minimum ?? 1"
      :max="lineHeightRange.maximum ?? 2"
      :step="0.1"
      :format="(value: number) => value.toFixed(1)"
      :label="t('settingsHost.rows.terminalLineHeight.label')"
      @update:model-value="(value: number) => prefs.set(TERMINAL_LINE_HEIGHT_SETTING, Math.round(value * 10) / 10)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_SCROLLBACK_SETTING">
    <SettingInput
      :model-value="scrollback"
      :parse="integerSetting(TERMINAL_SCROLLBACK_SETTING, t)"
      :label="t('settingsHost.rows.terminalScrollback.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(TERMINAL_SCROLLBACK_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_CURSOR_STYLE_SETTING">
    <SettingSeg
      :model-value="cursorStyle"
      :options="cursorOptions"
      :label="t('settingsHost.rows.terminalCursorStyle.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_CURSOR_STYLE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_CURSOR_BLINKING_SETTING">
    <SettingSwitch
      :model-value="cursorBlinking"
      :label="t('settingsHost.rows.terminalCursorBlinking.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_CURSOR_BLINKING_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING">
    <SettingSeg
      :model-value="pasteWarning"
      :options="pasteWarningOptions"
      :label="t('settingsHost.rows.terminalMultiLinePasteWarning.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_SHELL_INTEGRATION_SETTING">
    <SettingSwitch
      :model-value="shellIntegration"
      :label="t('settingsHost.rows.terminalShellIntegrationEnabled.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_SHELL_INTEGRATION_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_DECORATIONS_SETTING">
    <SettingSwitch
      :model-value="decorations"
      :label="t('settingsHost.rows.terminalShellIntegrationDecorationsEnabled.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_DECORATIONS_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="TERMINAL_CONFIRM_ON_KILL_SETTING">
    <SettingSeg
      :model-value="confirmOnKill"
      :options="confirmOnKillOptions"
      :label="t('settingsHost.rows.terminalConfirmOnKill.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_CONFIRM_ON_KILL_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    v-if="prefs.platform.value === 'darwin'"
    :id="TERMINAL_MAC_OPTION_IS_META_SETTING"
  >
    <SettingSwitch
      :model-value="macOptionIsMeta"
      :label="t('settingsHost.rows.terminalMacOptionIsMeta.label')"
      @update:model-value="(value) => prefs.set(TERMINAL_MAC_OPTION_IS_META_SETTING, value)"
    />
  </SettingsRow>
</template>
