<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileCode2, FolderSearch, GitBranch, Info, Palette, Server, SquareTerminal } from 'lucide-vue-next';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '@shared/settings-sections';
import type { ExtensionToWebviewMessage, SettingsFileScope } from '@shared/types/messages';
import SettingsModal, { type SettingsFooter } from '@/components/settings/SettingsModal.vue';
import ExtensionUiDialog from '@/components/ExtensionUiDialog.vue';
import { NO_HOST_SETTINGS, type HostSettings, type HostSettingsSection, type SettingsScopeView } from '@/components/settings/settings-rows';
import { useSettingWritesStore } from '@/components/settings/settings-writes';
import { settingsViewHandlers, type SettingsHandlerContext, type SettingsViewHandlers } from '@/composables/message-handler/handlers/settings-handlers';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import type { DamoclesOverlayApi, OverlaySettingsScope, OverlaySettingsScopes } from '../../../preload/overlay-channels';
import SettingsScopeTabs from './SettingsScopeTabs.vue';
import AboutSection from './AboutSection.vue';
import AppearanceSection from './AppearanceSection.vue';
import EditorSection from './EditorSection.vue';
import FilesSearchSection from './FilesSearchSection.vue';
import RemoteHostsSection from './RemoteHostsSection.vue';
import { REMOTE_HOSTS_TARGET } from './remote-hosts-target';
import SourceControlSection from './SourceControlSection.vue';
import TerminalSection from './TerminalSection.vue';
import { EDIT_SETTINGS_FILE } from './settings-file-link';
import LanguageRow from './LanguageRow.vue';
import NotifyRow from './NotifyRow.vue';
import NotifySoundRow from './NotifySoundRow.vue';
import type { OverlaySettingsBridge } from './overlay-bridge';
import { provideDesktopPrefs } from './desktop-prefs';
import { gitRowName } from './git-row-name';
import {
  EDITOR_AUTO_SAVE_SETTING,
  EDITOR_FORMAT_ON_SAVE_SETTING,
  EDITOR_DETECT_INDENTATION_SETTING,
  EDITOR_FONT_SIZE_SETTING,
  EDITOR_MINIMAP_SETTING,
  EDITOR_RENDER_WHITESPACE_SETTING,
  EDITOR_TAB_SIZE_SETTING,
  EDITOR_WORD_WRAP_SETTING,
  FILE_ICON_THEME_SETTING,
  FILES_EXCLUDE_SETTING,
  GIT_ALLOW_FORCE_PUSH_SETTING,
  GIT_ALLOW_NO_VERIFY_COMMIT_SETTING,
  GIT_ALWAYS_SIGN_OFF_SETTING,
  GIT_AUTOFETCH_PERIOD_SETTING,
  GIT_AUTOFETCH_SETTING,
  GIT_AUTO_STASH_SETTING,
  GIT_BRANCH_PREFIX_SETTING,
  GIT_BRANCH_PROTECTION_PROMPT_SETTING,
  GIT_BRANCH_PROTECTION_SETTING,
  GIT_CONFIRM_EMPTY_COMMITS_SETTING,
  GIT_CONFIRM_NO_VERIFY_COMMIT_SETTING,
  GIT_BLAME_EDITOR_DECORATION_SETTING,
  GIT_CONFIRM_SYNC_SETTING,
  GIT_DEFAULT_CLONE_DIRECTORY_SETTING,
  GIT_ENABLE_COMMIT_SIGNING_SETTING,
  GIT_ENABLE_SMART_COMMIT_SETTING,
  GIT_FOLLOW_TAGS_WHEN_SYNC_SETTING,
  GIT_INPUT_VALIDATION_LENGTH_SETTING,
  GIT_INPUT_VALIDATION_SETTING,
  GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING,
  GIT_OPEN_AFTER_CLONE_SETTING,
  GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING,
  GIT_POST_COMMIT_COMMAND_SETTING,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING,
  GIT_PRUNE_ON_FETCH_SETTING,
  GIT_PULL_BEFORE_CHECKOUT_SETTING,
  GIT_REBASE_WHEN_SYNC_SETTING,
  GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING,
  GIT_SMART_COMMIT_CHANGES_SETTING,
  GIT_SUGGEST_SMART_COMMIT_SETTING,
  GIT_UNTRACKED_CHANGES_SETTING,
  REMOTE_TERMINAL_IDLE_DAYS_SETTING,
  SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING,
  SEARCH_ACTIONS_POSITION_SETTING,
  SEARCH_COLLAPSE_RESULTS_SETTING,
  SEARCH_DEFAULT_VIEW_MODE_SETTING,
  SEARCH_EDITOR_CONTEXT_LINES_SETTING,
  SEARCH_EDITOR_DOUBLE_CLICK_SETTING,
  SEARCH_EDITOR_FOCUS_RESULTS_SETTING,
  SEARCH_EDITOR_REUSE_PRIOR_SETTING,
  SEARCH_EXCLUDE_SETTING,
  SEARCH_MAX_RESULTS_SETTING,
  SEARCH_MODE_SETTING,
  SEARCH_ON_TYPE_DEBOUNCE_SETTING,
  SEARCH_ON_TYPE_SETTING,
  SEARCH_SEED_ON_FOCUS_SETTING,
  SEARCH_SEED_WITH_NEAREST_WORD_SETTING,
  SEARCH_SHOW_LINE_NUMBERS_SETTING,
  SEARCH_SMART_CASE_SETTING,
  SEARCH_SORT_ORDER_SETTING,
  SEARCH_USE_REPLACE_PREVIEW_SETTING,
  TERMINAL_CONFIRM_ON_KILL_SETTING,
  TERMINAL_CURSOR_BLINKING_SETTING,
  TERMINAL_CURSOR_STYLE_SETTING,
  TERMINAL_DECORATIONS_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_FONT_FAMILY_SETTING,
  TERMINAL_FONT_SIZE_SETTING,
  TERMINAL_LINE_HEIGHT_SETTING,
  TERMINAL_MAC_OPTION_IS_META_SETTING,
  TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING,
  TERMINAL_PROFILES_SETTING,
  TERMINAL_SCROLLBACK_SETTING,
  TERMINAL_SHELL_INTEGRATION_SETTING,
  UPDATE_CHECK_AUTOMATICALLY_SETTING,
} from '../../../local-services/desktop-configuration';

const props = defineProps<{
  api: DamoclesOverlayApi;
  bridge: OverlaySettingsBridge;
  generation: number;
  section?: SettingsSectionId | undefined;
  account?: SettingsAccountId | undefined;
  release?: string | undefined;
  scopes?: OverlaySettingsScopes | undefined;
}>();

const emit = defineEmits<{
  (e: 'closed'): void;
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const extensionUiStore = useExtensionUiStore();
const writes = useSettingWritesStore();
const ctx: SettingsHandlerContext = {
  stores: { settingsStore, uiStore: useUIStore(), extensionUiStore, voiceJarvisStore: useVoiceJarvisStore() },
};

const prefs = provideDesktopPrefs(props.api);

// The Search group's rows in Files and search, in the order FilesSearchSection renders them.
const SEARCH_SETTINGS = [
  SEARCH_EXCLUDE_SETTING,
  SEARCH_MODE_SETTING,
  SEARCH_SORT_ORDER_SETTING,
  SEARCH_COLLAPSE_RESULTS_SETTING,
  SEARCH_DEFAULT_VIEW_MODE_SETTING,
  SEARCH_ACTIONS_POSITION_SETTING,
  SEARCH_SMART_CASE_SETTING,
  SEARCH_ON_TYPE_SETTING,
  SEARCH_SHOW_LINE_NUMBERS_SETTING,
  SEARCH_SEED_ON_FOCUS_SETTING,
  SEARCH_SEED_WITH_NEAREST_WORD_SETTING,
  SEARCH_USE_REPLACE_PREVIEW_SETTING,
  SEARCH_ON_TYPE_DEBOUNCE_SETTING,
  SEARCH_MAX_RESULTS_SETTING,
  SEARCH_EDITOR_DOUBLE_CLICK_SETTING,
  SEARCH_EDITOR_CONTEXT_LINES_SETTING,
  SEARCH_EDITOR_REUSE_PRIOR_SETTING,
  SEARCH_EDITOR_FOCUS_RESULTS_SETTING,
] as const;

// damocles.desktop.terminal.fontSize's strings are settingsHost.rows.terminalFontSize, shellIntegration.enabled's
// settingsHost.rows.terminalShellIntegrationEnabled.
const TERMINAL_PREFIX = 'damocles.desktop.terminal.';
const terminalRowName = (key: string): string => `terminal${key.slice(TERMINAL_PREFIX.length).split('.').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
// The terminal rows in the order TerminalSection renders them; macOS Option Is Meta exists only on macOS.
const TERMINAL_SETTINGS = (mac: boolean): string[] => [
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_PROFILES_SETTING,
  TERMINAL_FONT_SIZE_SETTING,
  TERMINAL_FONT_FAMILY_SETTING,
  TERMINAL_LINE_HEIGHT_SETTING,
  TERMINAL_SCROLLBACK_SETTING,
  TERMINAL_CURSOR_STYLE_SETTING,
  TERMINAL_CURSOR_BLINKING_SETTING,
  TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING,
  TERMINAL_SHELL_INTEGRATION_SETTING,
  TERMINAL_DECORATIONS_SETTING,
  TERMINAL_CONFIRM_ON_KILL_SETTING,
  ...(mac ? [TERMINAL_MAC_OPTION_IS_META_SETTING] : []),
];

// The Source control rows in the order SourceControlSection renders them; settingsHost.rows.git<Name> names each one's strings.
const GIT_SETTINGS = [
  GIT_AUTOFETCH_SETTING,
  GIT_AUTOFETCH_PERIOD_SETTING,
  GIT_PRUNE_ON_FETCH_SETTING,
  GIT_CONFIRM_SYNC_SETTING,
  GIT_REBASE_WHEN_SYNC_SETTING,
  GIT_FOLLOW_TAGS_WHEN_SYNC_SETTING,
  GIT_ALLOW_FORCE_PUSH_SETTING,
  GIT_AUTO_STASH_SETTING,
  GIT_PULL_BEFORE_CHECKOUT_SETTING,
  GIT_POST_COMMIT_COMMAND_SETTING,
  GIT_BRANCH_PROTECTION_SETTING,
  GIT_BRANCH_PROTECTION_PROMPT_SETTING,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_COMMIT_SETTING,
  GIT_PROMPT_TO_SAVE_FILES_BEFORE_STASH_SETTING,
  GIT_ALWAYS_SIGN_OFF_SETTING,
  GIT_ENABLE_COMMIT_SIGNING_SETTING,
  GIT_ALLOW_NO_VERIFY_COMMIT_SETTING,
  GIT_CONFIRM_NO_VERIFY_COMMIT_SETTING,
  GIT_CONFIRM_EMPTY_COMMITS_SETTING,
  GIT_ENABLE_SMART_COMMIT_SETTING,
  GIT_SUGGEST_SMART_COMMIT_SETTING,
  GIT_SMART_COMMIT_CHANGES_SETTING,
  GIT_INPUT_VALIDATION_SETTING,
  GIT_INPUT_VALIDATION_SUBJECT_LENGTH_SETTING,
  GIT_INPUT_VALIDATION_LENGTH_SETTING,
  GIT_BRANCH_PREFIX_SETTING,
  GIT_UNTRACKED_CHANGES_SETTING,
  GIT_REPOSITORY_SCAN_MAX_DEPTH_SETTING,
  GIT_OPEN_REPOSITORY_IN_PARENT_FOLDERS_SETTING,
  GIT_DEFAULT_CLONE_DIRECTORY_SETTING,
  GIT_OPEN_AFTER_CLONE_SETTING,
  GIT_BLAME_EDITOR_DECORATION_SETTING,
] as const;

// Remote hosts' rows after the idle-terminal limit, in the order RemoteHostsSection renders them: [row id, settingsHost.rows name].
const REMOTE_HOST_ROWS = [
  ['remote-hosts', 'remoteHosts'],
  ['remote-host-name', 'remoteHostName'],
  ['remote-host-color', 'remoteHostColor'],
  ['remote-host-mode', 'remoteHostMode'],
  ['remote-host-yolo', 'remoteHostYolo'],
  ['remote-host-agent', 'remoteHostAgent'],
  ['remote-host-remember', 'remoteHostRemember'],
  ['remote-host-local-network', 'remoteHostLocalNetwork'],
  ['remote-host-links', 'remoteHostLinks'],
  ['remote-host-credentials', 'remoteHostCredentials'],
  ['remote-host-os', 'remoteHostOs'],
  ['remote-host-install-folder', 'remoteHostInstallFolder'],
  ['remote-host-actions', 'remoteHostActions'],
] as const;

const REMOTE_HOSTS_SECTION: HostSettingsSection = {
  id: 'remoteHosts',
  label: 'settingsHost.sections.remoteHosts.label',
  subtitle: 'settingsHost.sections.remoteHosts.subtitle',
  icon: Server,
  component: RemoteHostsSection,
  rows: [
    { id: REMOTE_TERMINAL_IDLE_DAYS_SETTING, section: 'remoteHosts', label: 'settingsHost.rows.remoteTerminalIdleDays.label', description: 'settingsHost.rows.remoteTerminalIdleDays.description', keys: [REMOTE_TERMINAL_IDLE_DAYS_SETTING] },
    ...REMOTE_HOST_ROWS.map(([id, name]) => ({ id, section: 'remoteHosts' as const, label: `settingsHost.rows.${name}.label`, description: `settingsHost.rows.${name}.description` })),
  ],
};

const DESKTOP_SETTINGS = computed((): HostSettings => ({
  sections: [{
    id: 'appearance',
    label: 'settingsHost.sections.appearance.label',
    subtitle: 'settingsHost.sections.appearance.subtitle',
    icon: Palette,
    component: AppearanceSection,
    rows: [
      { id: 'damocles.desktop.theme', section: 'appearance', label: 'settingsHost.rows.theme.label', description: 'settingsHost.rows.theme.description', keys: ['damocles.desktop.theme'] },
      { id: FILE_ICON_THEME_SETTING, section: 'appearance', label: 'settingsHost.rows.fileIconTheme.label', description: 'settingsHost.rows.fileIconTheme.description', keys: [FILE_ICON_THEME_SETTING] },
      { id: 'damocles.desktop.reduceMotion', section: 'appearance', label: 'settingsHost.rows.reduceMotion.label', description: 'settingsHost.rows.reduceMotion.description', keys: ['damocles.desktop.reduceMotion'] },
      { id: 'damocles.desktop.restoreLayout', section: 'appearance', label: 'settingsHost.rows.restoreLayout.label', description: 'settingsHost.rows.restoreLayout.description', keys: ['damocles.desktop.restoreLayout'] },
      { id: SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING, section: 'appearance', label: 'settingsHost.rows.alwaysShowHeaderActions.label', description: 'settingsHost.rows.alwaysShowHeaderActions.description', keys: [SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING] },
      { id: 'restore-default-layout', section: 'appearance', label: 'settingsHost.rows.restoreDefaultLayout.label', description: 'settingsHost.rows.restoreDefaultLayout.description' },
    ],
  }, {
    id: 'editor',
    label: 'settingsHost.sections.editor.label',
    subtitle: 'settingsHost.sections.editor.subtitle',
    icon: FileCode2,
    component: EditorSection,
    rows: [
      { id: EDITOR_FONT_SIZE_SETTING, section: 'editor', label: 'settingsHost.rows.editorFontSize.label', description: 'settingsHost.rows.editorFontSize.description', keys: [EDITOR_FONT_SIZE_SETTING] },
      { id: EDITOR_TAB_SIZE_SETTING, section: 'editor', label: 'settingsHost.rows.editorTabSize.label', description: 'settingsHost.rows.editorTabSize.description', keys: [EDITOR_TAB_SIZE_SETTING] },
      { id: EDITOR_DETECT_INDENTATION_SETTING, section: 'editor', label: 'settingsHost.rows.editorDetectIndentation.label', description: 'settingsHost.rows.editorDetectIndentation.description', keys: [EDITOR_DETECT_INDENTATION_SETTING] },
      { id: EDITOR_WORD_WRAP_SETTING, section: 'editor', label: 'settingsHost.rows.editorWordWrap.label', description: 'settingsHost.rows.editorWordWrap.description', keys: [EDITOR_WORD_WRAP_SETTING] },
      { id: EDITOR_MINIMAP_SETTING, section: 'editor', label: 'settingsHost.rows.editorMinimap.label', description: 'settingsHost.rows.editorMinimap.description', keys: [EDITOR_MINIMAP_SETTING] },
      { id: EDITOR_RENDER_WHITESPACE_SETTING, section: 'editor', label: 'settingsHost.rows.editorRenderWhitespace.label', description: 'settingsHost.rows.editorRenderWhitespace.description', keys: [EDITOR_RENDER_WHITESPACE_SETTING] },
      { id: EDITOR_AUTO_SAVE_SETTING, section: 'editor', label: 'settingsHost.rows.editorAutoSave.label', description: 'settingsHost.rows.editorAutoSave.description', keys: [EDITOR_AUTO_SAVE_SETTING] },
      { id: EDITOR_FORMAT_ON_SAVE_SETTING, section: 'editor', label: 'settingsHost.rows.editorFormatOnSave.label', description: 'settingsHost.rows.editorFormatOnSave.description', keys: [EDITOR_FORMAT_ON_SAVE_SETTING] },
    ],
  }, {
    id: 'terminal',
    label: 'settingsHost.sections.terminal.label',
    subtitle: 'settingsHost.sections.terminal.subtitle',
    icon: SquareTerminal,
    component: TerminalSection,
    rows: [
      ...TERMINAL_SETTINGS(prefs.platform.value === 'darwin').map((key) => {
        const name = terminalRowName(key);
        return { id: key, section: 'terminal' as const, label: `settingsHost.rows.${name}.label`, description: `settingsHost.rows.${name}.description`, keys: [key] };
      }),
    ],
  }, {
    id: 'files',
    label: 'settingsHost.sections.files.label',
    subtitle: 'settingsHost.sections.files.subtitle',
    icon: FolderSearch,
    component: FilesSearchSection,
    rows: [
      { id: FILES_EXCLUDE_SETTING, section: 'files', label: 'settingsHost.rows.filesExclude.label', description: 'settingsHost.rows.filesExclude.description', keys: [FILES_EXCLUDE_SETTING] },
      ...SEARCH_SETTINGS.map((key) => {
        const name = key.slice('damocles.desktop.'.length);
        return { id: key, section: 'files' as const, label: `settingsHost.rows.${name}.label`, description: `settingsHost.rows.${name}.description`, keys: [key] };
      }),
    ],
  }, {
    id: 'sourceControl',
    label: 'settingsHost.sections.sourceControl.label',
    subtitle: 'settingsHost.sections.sourceControl.subtitle',
    icon: GitBranch,
    component: SourceControlSection,
    rows: GIT_SETTINGS.map((key) => {
      const name = gitRowName(key);
      return { id: key, section: 'sourceControl' as const, label: `settingsHost.rows.${name}.label`, description: `settingsHost.rows.${name}.description`, keys: [key] };
    }),
  }, ...(prefs.remoteEnabled.value ? [REMOTE_HOSTS_SECTION] : []), {
    id: 'about',
    label: 'settingsHost.sections.about.label',
    subtitle: 'settingsHost.sections.about.subtitle',
    icon: Info,
    component: AboutSection,
    rows: [
      { id: 'about-version', section: 'about', label: 'settingsHost.rows.aboutVersion.label', description: 'settingsHost.rows.aboutVersion.description' },
      { id: UPDATE_CHECK_AUTOMATICALLY_SETTING, section: 'about', label: 'settingsHost.rows.updateCheckAutomatically.label', description: 'settingsHost.rows.updateCheckAutomatically.description', keys: [UPDATE_CHECK_AUTOMATICALLY_SETTING] },
      { id: 'about-whats-new', section: 'about', label: 'settingsHost.rows.whatsNew.label', description: 'settingsHost.rows.whatsNew.description' },
    ],
  }],
  rows: [
    {
      section: 'application',
      component: LanguageRow,
      rows: [{ id: 'damocles.desktop.language', section: 'application', label: 'settingsHost.rows.language.label', description: 'settingsHost.rows.language.description', keys: ['damocles.desktop.language'] }],
    },
    {
      section: 'application',
      component: NotifyRow,
      rows: [{ id: 'damocles.desktop.notifications.enabled', section: 'application', label: 'settingsHost.rows.notify.label', description: 'settingsHost.rows.notify.description', keys: ['damocles.desktop.notifications.enabled'] }],
    },
    {
      section: 'application',
      component: NotifySoundRow,
      rows: [{ id: 'damocles.desktop.notifications.sound', section: 'application', label: 'settingsHost.rows.notifySound.label', description: 'settingsHost.rows.notifySound.description', keys: ['damocles.desktop.notifications.sound'] }],
    },
  ],
}));

// Changes on every re-attach, so the page remounts, nothing typed for the previous chat survives, and the modal asks for the new chat's state.
const attachment = ref(props.generation);
// A remote chat's tabs, as main attached the modal: active is always the tab of the attached core.
const scopes = shallowRef<OverlaySettingsScopes | undefined>(props.scopes);
// the tab clicked while main re-attaches the modal to that tab's core; the page lists nothing meanwhile
const pending = ref<OverlaySettingsScope | undefined>();
// the tab main could not attach the modal to, until the next attach
const failed = ref<OverlaySettingsScope | undefined>();
const shownScope = computed(() => (scopes.value === undefined ? undefined : pending.value ?? scopes.value.active));

function tabName(scope: OverlaySettingsScope): string {
  if (scope === 'machine') return scopes.value?.host.name ?? '';
  return scope === 'user' ? t('settingsScope.user') : t('settingsScope.project');
}

// The desktop app's own settings are this computer's, so only the User tab lists them.
const DESKTOP = computed((): HostSettings => (shownScope.value === undefined || shownScope.value === 'user' ? DESKTOP_SETTINGS.value : NO_HOST_SETTINGS));

// Voice runs on this computer whatever host the chat is on, so only the User tab lists it.
const USER_TAB_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['voice']);

// Each tab lists only what it writes: the User tab every file setting (the chat's own rows are the remote chat's, on its
// host tab), the host and Project tabs the keys core says they may write, the host tab also the attached chat's rows.
const scopeView = computed((): SettingsScopeView | undefined => {
  const current = scopes.value;
  const tab = shownScope.value;
  if (current === undefined || tab === undefined) return undefined;
  const writable = settingsStore.writableKeys;
  const hidden = tab === 'user' ? {} : { hidden: USER_TAB_SECTIONS };
  if (pending.value !== undefined || (tab !== 'user' && writable === undefined)) {
    return { listed: () => false, loading: t('settingsScope.loading', { tab: tabName(tab) }), ...hidden };
  }
  if (tab === 'user') {
    return {
      listed: (meta) => meta.section !== 'chat',
      empty: (section) => (section === 'chat' ? t('settingsScope.chatOnHost', { host: current.host.name }) : undefined),
    };
  }
  return { listed: (meta) => (tab === 'machine' && meta.section === 'chat') || (meta.keys ?? []).some((key) => writable!.has(key)), ...hidden };
});

// Edit settings.json offers the files of the tab shown: the host tab's user file is its host's machine file.
const footer = computed((): SettingsFooter => {
  const current = scopes.value;
  if (current === undefined) return { kind: 'settingsFiles' };
  if (current.active === 'machine') return { kind: 'settingsFiles', files: [{ scope: 'user', label: t('settingsScope.editHostFile', { host: current.host.name }) }] };
  return { kind: 'settingsFiles', files: current.active === 'user' ? [{ scope: 'user' }] : [{ scope: 'project' }, { scope: 'local' }] };
});

async function selectScope(scope: OverlaySettingsScope): Promise<void> {
  const current = scopes.value;
  if (!current || pending.value !== undefined || current.active === scope) return;
  pending.value = scope;
  failed.value = undefined;
  try {
    const answer = await props.api.setSettingsScope(scope);
    if (answer.ok && scopes.value) scopes.value = { ...scopes.value, active: answer.value };
  } catch {
    failed.value = scope;
  } finally {
    pending.value = undefined;
  }
}
const target = shallowRef<SettingsTarget>({
  ...(props.section !== undefined ? { section: props.section } : {}),
  ...(props.account !== undefined ? { account: props.account } : {}),
  ...(props.release !== undefined ? { release: props.release } : {}),
});

function dispatch(message: ExtensionToWebviewMessage): void {
  // A dispatch's replies reach this view whatever their type; only the settings types concern it.
  if (!Object.hasOwn(settingsViewHandlers, message.type)) return;
  const handler = settingsViewHandlers[message.type as keyof SettingsViewHandlers] as (m: ExtensionToWebviewMessage, c: SettingsHandlerContext) => void;
  handler(message, ctx);
}

// The overlay's stores outlive the modal, so each open and each attachment starts from none of another chat's values.
function attach(generation: number): void {
  props.bridge.setGeneration(generation);
  settingsStore.$reset();
  extensionUiStore.$reset();
  writes.$reset();
  attachment.value = generation;
}

const stops: Array<() => void> = [];
attach(props.generation);
stops.push(props.bridge.onMessage(dispatch));
stops.push(props.api.onSettingsAttached(({ generation, scopes: next }) => {
  scopes.value = next;
  // a re-attach of the previous tab follows a failed switch, which stays reported
  if (next === undefined || next.active === failed.value) failed.value = undefined;
  attach(generation);
}));
stops.push(props.api.onSettingsTarget((next) => (target.value = next)));
// the scope tab's host renamed or recolored while the modal shows it
stops.push(props.api.onSettingsScopeHost((host) => {
  if (scopes.value) scopes.value = { ...scopes.value, host };
}));

onBeforeUnmount(() => {
  for (const stop of stops) stop();
  extensionUiStore.$reset();
});

function editSettingsFile(scope: SettingsFileScope, key?: string): void {
  props.bridge.postMessage({ type: 'openSettingsFileInChat', scope, ...(key === undefined ? {} : { key }) });
  modal.value?.close();
}
provide(EDIT_SETTINGS_FILE, editSettingsFile);
provide(REMOTE_HOSTS_TARGET, computed(() => target.value.host));

const modal = ref<InstanceType<typeof SettingsModal> | null>(null);
</script>

<template>
  <SettingsModal
    ref="modal"
    :page-key="attachment"
    :scope-view="scopeView"
    :chat-host="scopes && scopes.active !== 'user' ? scopes.host.name : undefined"
    :host="DESKTOP"
    :footer="footer"
    backdrop="dim"
    :target="target"
    @closed="emit('closed')"
    @edit-settings-file="editSettingsFile"
  >
    <template
      v-if="scopes"
      #scope
    >
      <SettingsScopeTabs
        :scopes="scopes"
        :pending="pending"
        @select="selectScope"
      />
    </template>
    <template
      v-if="scopes"
      #scopeBanner="{ section: pageSection }"
    >
      <p
        class="text-11.5 leading-[1.45] text-(--d-danger-text)"
        role="status"
        data-testid="settings-scope-failed"
      >
        <span
          v-if="failed"
          class="mb-1 block px-2.5"
        >{{ t('settingsScope.switchFailed', { tab: tabName(failed) }) }}</span>
      </p>
      <div
        v-if="!scopeView?.loading"
        class="mb-1 flex items-center gap-2 rounded-lg bg-(--d-panel) px-2.5 py-2 text-11.5 leading-[1.45] text-(--d-muted)"
        data-testid="settings-scope-banner"
        role="note"
      >
        <span v-if="scopes.active === 'machine' && pageSection === 'chat'">{{ t('settingsScope.chatBanner', { host: scopes.host.name }) }}</span>
        <!-- {hostAgain}: i18n-t renders each slot once, and the host is named twice -->
        <i18n-t
          v-else-if="scopes.active === 'machine'"
          keypath="settingsScope.machineBanner"
          tag="span"
        >
          <template #host>
            <b class="font-semibold text-(--d-text)">{{ scopes.host.name }}</b>
          </template>
          <template #file>
            <span class="font-mono">~/.damocles/settings.json</span>
          </template>
          <template #hostAgain>
            {{ scopes.host.name }}
          </template>
        </i18n-t>
        <i18n-t
          v-else-if="scopes.active === 'project'"
          keypath="settingsScope.projectBanner"
          tag="span"
        >
          <template #file>
            <span class="font-mono">{{ scopes.projectFile ?? '.damocles/settings.json' }}</span>
          </template>
          <template #host>
            {{ scopes.host.name }}
          </template>
        </i18n-t>
        <span v-else>{{ t('settingsScope.userBanner') }}</span>
      </div>
    </template>
  </SettingsModal>
  <ExtensionUiDialog />
</template>
