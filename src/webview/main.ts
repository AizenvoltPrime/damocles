import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n } from './i18n';
import './style.css';
import { logBootResources } from './utils/perf';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(i18n);
app.mount('#app');
logBootResources();
