<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue';
import { Palette } from 'lucide-vue-next';
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
import AppearanceSection from './AppearanceSection.vue';
import LanguageRow from './LanguageRow.vue';
import NotifyRow from './NotifyRow.vue';
import NotifySoundRow from './NotifySoundRow.vue';
import type { OverlaySettingsBridge } from './overlay-bridge';
import { provideDesktopPrefs } from './desktop-prefs';

const props = defineProps<{
  api: DamoclesOverlayApi;
  bridge: OverlaySettingsBridge;
  generation: number;
  section?: SettingsSectionId | undefined;
  account?: SettingsAccountId | undefined;
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

provideDesktopPrefs(props.api);

const DESKTOP: HostSettings = {
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
};

// Changes on every re-attach, so the page remounts, nothing typed for the previous chat survives, and the modal asks for the new chat's state.
const attachment = ref(props.generation);
const target = shallowRef<SettingsTarget>({
  ...(props.section !== undefined ? { section: props.section } : {}),
  ...(props.account !== undefined ? { account: props.account } : {}),
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

function editSettingsFile(scope: SettingsFileScope): void {
  props.bridge.postMessage({ type: 'openSettingsFileInChat', scope });
  modal.value?.close();
}

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
