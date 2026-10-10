import type { Component } from 'vue';
import type { SettingsSectionId } from '@shared/settings-sections';

/**
 * A row as search sees it. `label` and `description` are i18n keys; `keys` are the damocles.* settings the row writes
 * (a field of one as `setting.field`, whose Saved hint and source badge show on the setting's row), which search matches
 * as VS Code matches setting ids. The row id is its first key when it has one (C9: data-testid="settings-row-{id}").
 */
export interface SettingsRowMeta {
  readonly id: string;
  readonly section: SettingsSectionId;
  readonly label: string;
  readonly description?: string;
  readonly keys?: readonly string[];
}

export interface SettingsSectionMeta {
  readonly id: SettingsSectionId;
  /** i18n keys */
  readonly label: string;
  readonly subtitle: string;
  readonly icon: Component;
}

/** A section only one host has (desktop Appearance). Its component renders its own rows with SettingsRow. */
export interface HostSettingsSection extends SettingsSectionMeta {
  readonly component: Component;
  readonly rows: readonly SettingsRowMeta[];
}

/** Rows only one host has, appended to a shared section (desktop Language and Notify me under Application). */
export interface HostSettingsRows {
  readonly section: SettingsSectionId;
  readonly component: Component;
  readonly rows: readonly SettingsRowMeta[];
}

/** What a host adds to the shared modal; the webview never asks which host it runs in. */
export interface HostSettings {
  readonly sections: readonly HostSettingsSection[];
  readonly rows: readonly HostSettingsRows[];
}

export const NO_HOST_SETTINGS: HostSettings = { sections: [], rows: [] };

const m = 'settingsModal.rows';

function row(section: SettingsSectionId, id: string, name: string, keys?: readonly string[]): SettingsRowMeta {
  return {
    id,
    section,
    label: `${m}.${name}.label`,
    description: `${m}.${name}.description`,
    ...(keys ? { keys } : {}),
  };
}

const teamKeys = (role: string): readonly string[] => [`damocles.team.${role}Model`, `damocles.team.${role}Effort`];

export const SETTINGS_ROWS: readonly SettingsRowMeta[] = [
  row('chat', 'workspace-folder', 'workspaceFolder'),
  row('chat', 'model', 'model'),
  row('chat', 'effort', 'effort'),
  row('chat', 'disable-thinking', 'disableThinking'),
  row('chat', 'permission-mode', 'permissionMode'),

  row('defaults', 'default-workspace-folder', 'defaultWorkspaceFolder'),
  row('defaults', 'damocles.model', 'defaultModel', ['damocles.model']),
  row('defaults', 'damocles.effortByModel', 'defaultEffort', ['damocles.effortByModel']),
  row('defaults', 'damocles.thinkingDisabled', 'defaultDisableThinking', ['damocles.thinkingDisabled']),
  row('defaults', 'damocles.permissionMode', 'defaultPermissionMode', ['damocles.permissionMode']),
  row('defaults', 'damocles.dangerouslySkipPermissions', 'defaultYolo', ['damocles.dangerouslySkipPermissions']),
  row('defaults', 'damocles.ideContext.enabled', 'ideContext', ['damocles.ideContext.enabled']),

  row('accounts', 'account-anthropic', 'anthropic'),
  row('accounts', 'account-openai', 'openai'),
  row('accounts', 'account-deepseek', 'deepseek'),
  row('accounts', 'account-stepfun', 'stepfun'),
  row('accounts', 'account-openrouter', 'openrouter'),
  row('accounts', 'account-typesafe', 'typesafe'),
  row('accounts', 'damocles.explore.model', 'exploreModel', ['damocles.explore.model', 'damocles.explore.effort']),
  row('accounts', 'damocles.background.model', 'backgroundModel', ['damocles.background.model', 'damocles.background.effort']),
  row('accounts', 'damocles.memory.judge', 'memoryJudge', ['damocles.memory.judge', 'damocles.memory.judgeEffort']),

  row('teams', 'damocles.team.enabled', 'teamEnabled', ['damocles.team.enabled']),
  row('teams', 'damocles.team.leadModel', 'teamLead', teamKeys('lead')),
  row('teams', 'damocles.team.implementorModel', 'teamImplementor', teamKeys('implementor')),
  row('teams', 'damocles.team.reviewerModel', 'teamReviewer', teamKeys('reviewer')),

  row('workspace', 'damocles.maxBudgetUsd', 'budget', ['damocles.maxBudgetUsd']),
  row('workspace', 'damocles.autoCompact', 'autoCompact', ['damocles.autoCompact']),
  row('workspace', 'damocles.autoCompact.triggerPercent', 'autoCompactTrigger', ['damocles.autoCompact.triggerPercent']),
  row('workspace', 'damocles.taskBudget', 'taskBudget', ['damocles.taskBudget']),

  row('application', 'damocles.cacheWarming', 'cacheWarming', ['damocles.cacheWarming']),
  row('application', 'damocles.checkpoints.retentionDays', 'checkpointRetention', ['damocles.checkpoints.retentionDays']),

  row('integrations', 'damocles.mcp.enabled', 'mcp', ['damocles.mcp.enabled']),
  row('integrations', 'damocles.memory.enabled', 'memory', ['damocles.memory.enabled']),
  row('integrations', 'damocles.compass.enabled', 'compass', ['damocles.compass.enabled']),
  row('integrations', 'damocles.browser.enabled', 'browser', ['damocles.browser.enabled']),
  row('integrations', 'damocles.pi.webSearch.enabled', 'webSearch', ['damocles.pi.webSearch.enabled']),
  row('integrations', 'damocles.imageGeneration.enabled', 'imageGeneration', ['damocles.imageGeneration.enabled']),
  row('integrations', 'damocles.imageGeneration.model', 'imageModel', ['damocles.imageGeneration.model']),

  row('voice', 'damocles.voice.mode', 'voiceMode', ['damocles.voice.mode']),
  row('voice', 'damocles.voice.provider', 'voiceProvider', ['damocles.voice.provider']),
  row('voice', 'voice-api-key', 'voiceApiKey'),
  row('voice', 'damocles.voice.language', 'voiceLanguage', ['damocles.voice.language']),
  row('voice', 'damocles.voice.wakeWordSensitivity', 'wakeSensitivity', ['damocles.voice.wakeWordSensitivity']),
  row('voice', 'damocles.voice.tts.enabled', 'ttsEnabled', ['damocles.voice.tts.enabled']),
  row('voice', 'damocles.voice.tts.voice', 'ttsVoice', ['damocles.voice.tts.voice']),
  row('voice', 'damocles.voice.localGpu', 'localGpu', ['damocles.voice.localGpu']),
  row('voice', 'damocles.voice.autoSubmit', 'autoSubmit', ['damocles.voice.autoSubmit']),
  row('voice', 'damocles.voice.endOfTurnSilenceMs', 'endOfTurn', ['damocles.voice.endOfTurnSilenceMs']),
  row('voice', 'damocles.voice.maxUtteranceMs', 'maxUtterance', ['damocles.voice.maxUtteranceMs']),
  row('voice', 'damocles.voice.diagnostics', 'diagnostics', ['damocles.voice.diagnostics']),
  row('voice', 'voice-files', 'voiceFiles'),
];

/** Case-insensitive; empty means no query. */
export function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function rowMatches(meta: SettingsRowMeta, query: string, translate: (key: string) => string): boolean {
  if (query === '') return true;
  const haystack = [translate(meta.label), meta.description ? translate(meta.description) : '', ...(meta.keys ?? [])];
  return haystack.some((text) => text.toLocaleLowerCase().includes(query));
}
