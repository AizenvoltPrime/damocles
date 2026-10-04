import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import OverlayApp from './OverlayApp.vue';
import { shellI18n } from '../i18n';
import { addSettingsMessages } from './settings/settings-messages';
import { createOverlaySettingsBridge } from './settings/overlay-bridge';
import './overlay.css';

const api = window.damoclesOverlay;
if (!api) throw new Error('The Damocles overlay page loaded without its preload');

// Installed before anything reads the bridge: the settings components the overlay mounts post through it.
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

createApp(OverlayApp, { api, settingsBridge }).use(createPinia()).use(shellI18n).mount('#app');
