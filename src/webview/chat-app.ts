import { createApp, type App as VueApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { CODE_HIGHLIGHTER } from './composables/code-highlighter';
import { SHIKI_HIGHLIGHTER } from './composables/useShikiHighlighter';
import { i18n } from './i18n';

/** The chat view as an app, with its stores, its catalog and the code highlighter every component of it shares. */
export function createChatApp(): VueApp {
  return createApp(App).use(createPinia()).use(i18n).provide(CODE_HIGHLIGHTER, SHIKI_HIGHLIGHTER);
}
