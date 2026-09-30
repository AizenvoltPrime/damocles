import { createApp } from 'vue';
import PaneApp from './PaneApp.vue';
import { shellI18n } from '../i18n';
import './pane.css';

const api = window.damoclesPane;
if (!api) throw new Error('The Damocles pane page loaded without its preload');

createApp(PaneApp, { api }).use(shellI18n).mount('#app');
