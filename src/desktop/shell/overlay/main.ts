// First, so the bundle opens with its @layer statement, ahead of every layered block the components' CSS adds.
import './overlay.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import OverlayApp from './OverlayApp.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import { addSettingsMessages, applySettingsLocale } from './settings/settings-messages';
import { createOverlaySettingsBridge } from './settings/overlay-bridge';
import { NOTIFIER_PAGE_PATH, THEME_EDITOR_PAGE_PATH } from '../../preload/page-paths';
import { mountNotifier } from './notifier-page';
import { mountThemeEditor } from './theme-editor/editor-page';
import { installRasterizer } from './rasterize';

const api = window.damoclesOverlay;
if (!api) throw new Error('The Damocles overlay page loaded without its preload');

// Not awaited: main's load handshake needs the mount at once. Requests and toasts wait for it (createLocaleHold).
void applyShellLocale(document.documentElement.lang);

// Main serves this bundle at three pages; the desktop popup window's needs only the toast stack, the theme editor dock's
// only the editor.
if (location.pathname === NOTIFIER_PAGE_PATH) {
  mountNotifier(api);
} else if (location.pathname === THEME_EDITOR_PAGE_PATH) {
  mountThemeEditor(api);
} else {
  // Installed before anything reads the bridge: the settings components the overlay mounts post through it.
  const settingsBridge = createOverlaySettingsBridge(api);
  installPlatformBridge(settingsBridge);
  addSettingsMessages();
  // A settings request waits for these catalogs too, so they start with the shell's rather than at main's first state.
  void applySettingsLocale(document.documentElement.lang);

  createApp(OverlayApp, { api, settingsBridge }).use(createPinia()).use(shellI18n).mount('#app');
  installRasterizer(api);
}
