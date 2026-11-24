// First, so the bundle opens with its @layer statement, ahead of every layered block the components' CSS adds.
import './style.css';
import { createChatApp } from './chat-app';
import { mountInInitialLocale } from './i18n';
import { logBootResources } from './utils/perf';
import { mirrorVsCodeReduceMotion } from './utils/reducedMotion';

// Desktop's preload sets data-reduced-motion from damocles.desktop.reduceMotion; VS Code reports its own setting on body.
if (typeof acquireVsCodeApi === 'function') mirrorVsCodeReduceMotion();

const app = createChatApp();
void mountInInitialLocale(() => {
  app.mount('#app');
  logBootResources();
});
