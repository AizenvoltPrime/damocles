import { createApp } from 'vue';
import type { DamoclesOverlayApi } from '../../preload/overlay-channels';
import { shellI18n } from '../i18n';
import NotifierApp from './NotifierApp.vue';

export function mountNotifier(api: DamoclesOverlayApi): void {
  createApp(NotifierApp, { api }).use(shellI18n).mount('#app');
}
