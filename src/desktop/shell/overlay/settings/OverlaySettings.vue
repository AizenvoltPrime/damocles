<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, shallowRef } from 'vue';
import { FileCode2, FolderSearch, Info, Palette, SquareTerminal } from 'lucide-vue-next';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '@shared/settings-sections';
import type { ExtensionToWebviewMessage, SettingsFileScope } from '@shared/types/messages';
import SettingsModal from '@/components/settings/SettingsModal.vue';
import ExtensionUiDialog from '@/components/ExtensionUiDialog.vue';
import type { HostSettings } from '@/components/settings/settings-rows';
import { useSettingWritesStore } from '@/components/settings/settings-writes';
import { settingsViewHandlers, type SettingsHandlerContext, type SettingsViewHandlers } from '@/composables/message-handler/handlers/settings-handlers';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import type { DamoclesOverlayApi } from '../../../preload/overlay-channels';
import AboutSection from './AboutSection.vue';
import AppearanceSection from './AppearanceSection.vue';
import EditorSection from './EditorSection.vue';
import FilesSearchSection from './FilesSearchSection.vue';
import TerminalSection from './TerminalSection.vue';
import { EDIT_SETTINGS_FILE } from './settings-file-link';
import LanguageRow from './LanguageRow.vue';
import NotifyRow from './NotifyRow.vue';
import NotifySoundRow from './NotifySoundRow.vue';
import type { OverlaySettingsBridge } from './overlay-bridge';
import { provideDesktopPrefs } from './desktop-prefs';
import {
  EDITOR_AUTO_SAVE_SETTING,
  EDITOR_FORMAT_ON_SAVE_SETTING,
  EDITOR_DETECT_INDENTATION_SETTING,
  EDITOR_FONT_SIZE_SETTING,
  EDITOR_MINIMAP_SETTING,
  EDITOR_RENDER_WHITESPACE_SETTING,
  EDITOR_TAB_SIZE_SETTING,
  EDITOR_WORD_WRAP_SETTING,
  FILES_EXCLUDE_SETTING,
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
} from '../../../main/desktop-configuration';

const props = defineProps<{
  api: DamoclesOverlayApi;
  bridge: OverlaySettingsBridge;
  generation: number;
  section?: SettingsSectionId | undefined;
  account?: SettingsAccountId | undefined;
  release?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'closed'): void;
}>();

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

const DESKTOP = computed((): HostSettings => ({
  sections: [{
    id: 'appearance',
    label: 'settingsHost.sections.appearance.label',
    subtitle: 'settingsHost.sections.appearance.subtitle',
    icon: Palette,
    component: AppearanceSection,
    rows: [
      { id: 'damocles.desktop.theme', section: 'appearance', label: 'settingsHost.rows.theme.label', description: 'settingsHost.rows.theme.description', keys: ['damocles.desktop.theme'] },
      { id: 'damocles.desktop.reduceMotion', section: 'appearance', label: 'settingsHost.rows.reduceMotion.label', description: 'settingsHost.rows.reduceMotion.description', keys: ['damocles.desktop.reduceMotion'] },
      { id: 'damocles.desktop.restoreLayout', section: 'appearance', label: 'settingsHost.rows.restoreLayout.label', description: 'settingsHost.rows.restoreLayout.description', keys: ['damocles.desktop.restoreLayout'] },
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
    id: 'about',
    label: 'settingsHost.sections.about.label',
    subtitle: 'settingsHost.sections.about.subtitle',
    icon: Info,
    component: AboutSection,
    rows: [
      { id: 'about-version', section: 'about', label: 'settingsHost.rows.aboutVersion.label', description: 'settingsHost.rows.aboutVersion.description' },
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
stops.push(props.api.onSettingsAttached(({ generation }) => attach(generation)));
stops.push(props.api.onSettingsTarget((next) => (target.value = next)));

onBeforeUnmount(() => {
  for (const stop of stops) stop();
  extensionUiStore.$reset();
});

function editSettingsFile(scope: SettingsFileScope, key?: string): void {
  props.bridge.postMessage({ type: 'openSettingsFileInChat', scope, ...(key === undefined ? {} : { key }) });
  modal.value?.close();
}
provide(EDIT_SETTINGS_FILE, editSettingsFile);

const modal = ref<InstanceType<typeof SettingsModal> | null>(null);
</script>

<template>
  <SettingsModal
    ref="modal"
    :page-key="attachment"
    :host="DESKTOP"
    :footer="{ kind: 'settingsFiles' }"
    backdrop="dim"
    :target="target"
    @closed="emit('closed')"
    @edit-settings-file="editSettingsFile"
  />
  <ExtensionUiDialog />
</template>
