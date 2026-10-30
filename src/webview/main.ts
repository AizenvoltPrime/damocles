import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n, mountInInitialLocale } from './i18n';
import './style.css';
import { logBootResources } from './utils/perf';
import { mirrorVsCodeReduceMotion } from './utils/reducedMotion';

// Desktop's preload sets data-reduced-motion from damocles.desktop.reduceMotion; VS Code reports its own setting on body.
if (typeof acquireVsCodeApi === 'function') mirrorVsCodeReduceMotion();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(i18n);
void mountInInitialLocale(() => {
  app.mount('#app');
  logBootResources();
});
