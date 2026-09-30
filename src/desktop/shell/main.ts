import { createApp } from 'vue';
import App from './App.vue';
import { shellI18n } from './i18n';
import './style.css';

const api = window.damoclesShell;
if (!api) throw new Error('The Damocles shell page loaded without its preload');

createApp(App, { api }).use(shellI18n).mount('#app');
