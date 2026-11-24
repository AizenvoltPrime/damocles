import { createApp, type App } from 'vue';
import { createPinia } from 'pinia';
import { CODE_HIGHLIGHTER } from '@/composables/code-highlighter';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { RenderAppearance } from '@shared/themes/agent';
import { desktopHostCapabilities } from '../../local-services/capabilities';
import { RENDER_HIGHLIGHTER } from './render-highlighter';
import SampleTranscript from './SampleTranscript.vue';
import { sampleMessages } from './sample-window';

/**
 * The sample chat as its own app, in the chat view's i18n (English) and stores, with the desktop chat page's capabilities
 * and the page's own code highlighter.
 */
export function createTranscriptApp(platform: RenderAppearance['platform'], now: number): App {
  const pinia = createPinia();
  const app = createApp(SampleTranscript, { messages: sampleMessages(now) }).use(pinia).use(i18n).provide(CODE_HIGHLIGHTER, RENDER_HIGHLIGHTER);
  useSettingsStore(pinia).setHostCapabilities(desktopHostCapabilities(platform));
  return app;
}
