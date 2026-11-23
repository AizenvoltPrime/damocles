import { createApp } from 'vue';
// the .sm-* controls the editor draws; Settings imports the same sheet, and this page mounts without it
import '@/components/settings/settings.css';
import type { DamoclesOverlayApi } from '../../../preload/overlay-channels';
import { shellI18n } from '../../i18n';
import ThemeEditor from './ThemeEditor.vue';

/** The theme editor dock's page: the overlay bundle at its editor route, which shows only the editor. */
export function mountThemeEditor(api: DamoclesOverlayApi): void {
  createApp(ThemeEditor, { api }).use(shellI18n).mount('#app');
}
