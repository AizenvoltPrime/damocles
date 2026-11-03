import { createApp } from 'vue';
import App from './App.vue';
import { applyShellLocale, shellI18n } from './i18n';
import './style.css';

const api = window.damoclesShell;
if (!api) throw new Error('The Damocles shell page loaded without its preload');

// Mounted once the language main built the page in (<html lang>) is ready, so the first frame is in it.
void applyShellLocale(document.documentElement.lang).then(() => createApp(App, { api }).use(shellI18n).mount('#app'));
