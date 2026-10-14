<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingInput from '@/components/settings/controls/SettingInput.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import type { InputParse } from '@/components/settings/controls/SettingInput.vue';
import { useSettingsPage } from '@/components/settings/settings-view';
import {
  DESKTOP_CONFIGURATION,
  GIT_ALLOW_FORCE_PUSH_SETTING,
  GIT_ALLOW_NO_VERIFY_COMMIT_SETTING,
  GIT_ALWAYS_SIGN_OFF_SETTING,
  GIT_AUTOFETCH_PERIOD_SETTING,
  GIT_AUTOFETCH_SETTING,
  GIT_AUTO_STASH_SETTING,
  GIT_BRANCH_PREFIX_SETTING,
  GIT_BRANCH_PROTECTION_PROMPT_SETTING,
  GIT_BRANCH_PROTECTION_PROMPTS,
  GIT_BRANCH_PROTECTION_SETTING,
  GIT_CONFIRM_EMPTY_COMMITS_SETTING,
  GIT_CONFIRM_NO_VERIFY_COMMIT_SETTING,
  GIT_CONFIRM_SYNC_SETTING,
  GIT_DEFAULT_CLONE_DIRECTORY_SETTING,
  GIT_ENABLE_COMMIT_SIGNING_SETTING,
  GIT_ENABLE_SMART_COMMIT_SETTING,
  GIT_FOLLOW_TAGS_WHEN_SYNC_SETTING,
  GIT_INPUT_VALIDATION_LENGTH_SETTING,
  GIT_INPUT_VALIDATION_SETTING,
  GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING,
  GIT_OPEN_AFTER_CLONE,
  GIT_OPEN_AFTER_CLONE_SETTING,
  GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS,
  GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING,
  GIT_POST_COMMIT_COMMAND_SETTING,
  GIT_POST_COMMIT_COMMANDS,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING,
  GIT_PRUNE_ON_FETCH_SETTING,
  GIT_PULL_BEFORE_CHECKOUT_SETTING,
  GIT_REBASE_WHEN_SYNC_SETTING,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING,
  GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING,
  GIT_SMART_COMMIT_CHANGES,
  GIT_SMART_COMMIT_CHANGES_SETTING,
  GIT_SUGGEST_SMART_COMMIT_SETTING,
  GIT_UNTRACKED_CHANGES,
  GIT_UNTRACKED_CHANGES_SETTING,
} from '../../../main/desktop-configuration';
import { useDesktopPrefs } from './desktop-prefs';
import { integerSetting } from './integer-setting';
import { gitRowName } from './git-row-name';

// The damocles.desktop.git.* keys (D64), with VS Code's defaults, in OverlaySettings' GIT_SETTINGS order.
const { t } = useI18n();
const prefs = useDesktopPrefs();
const page = useSettingsPage();

const valueOf = (key: string): unknown => prefs.values.value[key] ?? DESKTOP_CONFIGURATION[key]?.default;
const untracked = computed(() => GIT_UNTRACKED_CHANGES.find((value) => value === valueOf(GIT_UNTRACKED_CHANGES_SETTING)) ?? 'mixed');
const parentFolders = computed(() => GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS.find((value) => value === valueOf(GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING)) ?? 'prompt');
const scanDepth = computed(() => String(valueOf(GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING)));
const subjectLength = computed(() => String(valueOf(GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING)));
const lineLength = computed(() => String(valueOf(GIT_INPUT_VALIDATION_LENGTH_SETTING)));
const autofetchPeriod = computed(() => String(valueOf(GIT_AUTOFETCH_PERIOD_SETTING)));

const parseScanDepth = integerSetting(GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING, t);
const parseSubjectLength = integerSetting(GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING, t);
const parseLineLength = integerSetting(GIT_INPUT_VALIDATION_LENGTH_SETTING, t);
const parseAutofetchPeriod = integerSetting(GIT_AUTOFETCH_PERIOD_SETTING, t);

const postCommit = computed(() => GIT_POST_COMMIT_COMMANDS.find((value) => value === valueOf(GIT_POST_COMMIT_COMMAND_SETTING)) ?? 'none');
const postCommitOptions = computed(() => GIT_POST_COMMIT_COMMANDS.map((value) => ({ value, label: t(`settingsHost.git.postCommit.${value}`) })));
const openAfterClone = computed(() => GIT_OPEN_AFTER_CLONE.find((value) => value === valueOf(GIT_OPEN_AFTER_CLONE_SETTING)) ?? 'prompt');
const openAfterCloneOptions = computed(() => GIT_OPEN_AFTER_CLONE.map((value) => ({ value, label: t(`settingsHost.git.openAfterClone.${value}`) })));
const cloneDirectory = computed(() => {
  const value = valueOf(GIT_DEFAULT_CLONE_DIRECTORY_SETTING);
  return typeof value === 'string' ? value : '';
});
const protectionPrompt = computed(() => GIT_BRANCH_PROTECTION_PROMPTS.find((value) => value === valueOf(GIT_BRANCH_PROTECTION_PROMPT_SETTING)) ?? 'alwaysPrompt');
const protectionPromptOptions = computed(() => GIT_BRANCH_PROTECTION_PROMPTS.map((value) => ({ value, label: t(`settingsHost.git.protectionPrompt.${value}`) })));
const saveBeforeCommit = computed(() => GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT.find((value) => value === valueOf(GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING)) ?? 'always');
const saveBeforeCommitOptions = computed(() => GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT.map((value) => ({ value, label: t(`settingsHost.git.saveBeforeCommit.${value}`) })));
const saveBeforeStash = computed(() => GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH.find((value) => value === valueOf(GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING)) ?? 'always');
const saveBeforeStashOptions = computed(() => GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH.map((value) => ({ value, label: t(`settingsHost.git.saveBeforeStash.${value}`) })));
const smartChanges = computed(() => GIT_SMART_COMMIT_CHANGES.find((value) => value === valueOf(GIT_SMART_COMMIT_CHANGES_SETTING)) ?? 'all');
const smartChangesOptions = computed(() => GIT_SMART_COMMIT_CHANGES.map((value) => ({ value, label: t(`settingsHost.git.smartChanges.${value}`) })));
const protectedBranches = computed(() => {
  const value = valueOf(GIT_BRANCH_PROTECTION_SETTING);
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string').join(', ') : '';
});
const branchPrefix = computed(() => {
  const value = valueOf(GIT_BRANCH_PREFIX_SETTING);
  return typeof value === 'string' ? value : '';
});
// appendix C: one comma-separated input; an empty one stores an empty list
const parseBranchList: InputParse<string[]> = (raw) => ({ ok: true, value: raw.split(',').map((name) => name.trim()).filter((name) => name !== '') });
const parseText: InputParse<string> = (raw) => ({ ok: true, value: raw });
// an empty folder stores '' so Clone asks; a path is stored trimmed, and main checks it when Clone uses it
const parseFolder: InputParse<string> = (raw) => ({ ok: true, value: raw.trim() });

// Fetch and sync, in the prototype's order; Autofetch period sits after Autofetch.
const SYNC_SWITCHES = [
  GIT_PRUNE_ON_FETCH_SETTING,
  GIT_CONFIRM_SYNC_SETTING,
  GIT_REBASE_WHEN_SYNC_SETTING,
  GIT_FOLLOW_TAGS_WHEN_SYNC_SETTING,
  GIT_ALLOW_FORCE_PUSH_SETTING,
  GIT_AUTO_STASH_SETTING,
  GIT_PULL_BEFORE_CHECKOUT_SETTING,
] as const;

const SWITCHES = [
  GIT_ALWAYS_SIGN_OFF_SETTING,
  GIT_ENABLE_COMMIT_SIGNING_SETTING,
  GIT_ALLOW_NO_VERIFY_COMMIT_SETTING,
  GIT_CONFIRM_NO_VERIFY_COMMIT_SETTING,
  GIT_CONFIRM_EMPTY_COMMITS_SETTING,
  GIT_ENABLE_SMART_COMMIT_SETTING,
  GIT_SUGGEST_SMART_COMMIT_SETTING,
] as const;

const untrackedOptions = computed(() => GIT_UNTRACKED_CHANGES.map((value) => ({ value, label: t(`settingsHost.git.untracked.${value}`) })));
const parentOptions = computed(() => GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS.map((value) => ({ value, label: t(`settingsHost.git.parentFolders.${value}`) })));
</script>

<template>
  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-fetch-sync"
  >
    {{ t('settingsHost.groups.fetchSync') }}
  </div>
  <SettingsRow :id="GIT_AUTOFETCH_SETTING">
    <SettingSwitch
      :model-value="valueOf(GIT_AUTOFETCH_SETTING) === true"
      :label="t('settingsHost.rows.gitAutofetch.label')"
      @update:model-value="(value) => prefs.set(GIT_AUTOFETCH_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_AUTOFETCH_PERIOD_SETTING">
    <SettingInput
      :model-value="autofetchPeriod"
      :parse="parseAutofetchPeriod"
      :label="t('settingsHost.rows.gitAutofetchPeriod.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(GIT_AUTOFETCH_PERIOD_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    v-for="key in SYNC_SWITCHES"
    :id="key"
    :key="key"
  >
    <SettingSwitch
      :model-value="valueOf(key) === true"
      :label="t(`settingsHost.rows.${gitRowName(key)}.label`)"
      @update:model-value="(value) => prefs.set(key, value)"
    />
  </SettingsRow>
  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-commit"
  >
    {{ t('settingsHost.groups.commit') }}
  </div>
  <SettingsRow :id="GIT_POST_COMMIT_COMMAND_SETTING">
    <SettingSeg
      :model-value="postCommit"
      :options="postCommitOptions"
      :label="t('settingsHost.rows.gitPostCommitCommand.label')"
      @update:model-value="(value) => prefs.set(GIT_POST_COMMIT_COMMAND_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_BRANCH_PROTECTION_SETTING">
    <SettingInput
      :model-value="protectedBranches"
      :parse="parseBranchList"
      :label="t('settingsHost.rows.gitBranchProtection.label')"
      :placeholder="t('settingsHost.git.none')"
      wide
      @commit="(value: string[]) => prefs.set(GIT_BRANCH_PROTECTION_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_BRANCH_PROTECTION_PROMPT_SETTING">
    <SettingSelect
      :model-value="protectionPrompt"
      :options="protectionPromptOptions"
      :label="t('settingsHost.rows.gitBranchProtectionPrompt.label')"
      @update:model-value="(value) => prefs.set(GIT_BRANCH_PROTECTION_PROMPT_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING">
    <SettingSeg
      :model-value="saveBeforeCommit"
      :options="saveBeforeCommitOptions"
      :label="t('settingsHost.rows.gitPromptToSaveFilesBeforeCommit.label')"
      @update:model-value="(value) => prefs.set(GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING">
    <SettingSeg
      :model-value="saveBeforeStash"
      :options="saveBeforeStashOptions"
      :label="t('settingsHost.rows.gitPromptToSaveFilesBeforeStash.label')"
      @update:model-value="(value) => prefs.set(GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    v-for="key in SWITCHES"
    :id="key"
    :key="key"
  >
    <SettingSwitch
      :model-value="valueOf(key) === true"
      :label="t(`settingsHost.rows.${gitRowName(key)}.label`)"
      @update:model-value="(value) => prefs.set(key, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_SMART_COMMIT_CHANGES_SETTING">
    <SettingSeg
      :model-value="smartChanges"
      :options="smartChangesOptions"
      :label="t('settingsHost.rows.gitSmartCommitChanges.label')"
      @update:model-value="(value) => prefs.set(GIT_SMART_COMMIT_CHANGES_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_INPUT_VALIDATION_SETTING">
    <SettingSwitch
      :model-value="valueOf(GIT_INPUT_VALIDATION_SETTING) === true"
      :label="t('settingsHost.rows.gitInputValidation.label')"
      @update:model-value="(value) => prefs.set(GIT_INPUT_VALIDATION_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING">
    <SettingInput
      :model-value="subjectLength"
      :parse="parseSubjectLength"
      :label="t('settingsHost.rows.gitInputValidationSubjectLength.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_INPUT_VALIDATION_LENGTH_SETTING">
    <SettingInput
      :model-value="lineLength"
      :parse="parseLineLength"
      :label="t('settingsHost.rows.gitInputValidationLength.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(GIT_INPUT_VALIDATION_LENGTH_SETTING, value)"
    />
  </SettingsRow>
  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-branches"
  >
    {{ t('settingsHost.groups.branches') }}
  </div>
  <SettingsRow :id="GIT_BRANCH_PREFIX_SETTING">
    <SettingInput
      :model-value="branchPrefix"
      :parse="parseText"
      :label="t('settingsHost.rows.gitBranchPrefix.label')"
      :placeholder="t('settingsHost.git.none')"
      @commit="(value: string) => prefs.set(GIT_BRANCH_PREFIX_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_UNTRACKED_CHANGES_SETTING">
    <SettingSeg
      :model-value="untracked"
      :options="untrackedOptions"
      :label="t('settingsHost.rows.gitUntrackedChanges.label')"
      @update:model-value="(value) => prefs.set(GIT_UNTRACKED_CHANGES_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING">
    <SettingInput
      :model-value="scanDepth"
      :parse="parseScanDepth"
      :label="t('settingsHost.rows.gitRepositoryScanMaxDepth.label')"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING">
    <SettingSeg
      :model-value="parentFolders"
      :options="parentOptions"
      :label="t('settingsHost.rows.gitOpenRepositoryInParentFolders.label')"
      @update:model-value="(value) => prefs.set(GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING, value)"
    />
  </SettingsRow>
  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-clone"
  >
    {{ t('settingsHost.groups.clone') }}
  </div>
  <SettingsRow :id="GIT_DEFAULT_CLONE_DIRECTORY_SETTING">
    <SettingInput
      :model-value="cloneDirectory"
      :parse="parseFolder"
      :label="t('settingsHost.rows.gitDefaultCloneDirectory.label')"
      :placeholder="t('settingsHost.git.askEachTime')"
      wide
      @commit="(value: string) => prefs.set(GIT_DEFAULT_CLONE_DIRECTORY_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="GIT_OPEN_AFTER_CLONE_SETTING">
    <SettingSeg
      :model-value="openAfterClone"
      :options="openAfterCloneOptions"
      :label="t('settingsHost.rows.gitOpenAfterClone.label')"
      @update:model-value="(value) => prefs.set(GIT_OPEN_AFTER_CLONE_SETTING, value)"
    />
  </SettingsRow>
</template>
