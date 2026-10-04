import { defineAsyncComponent } from 'vue';
import type { HostSettings } from './settings-rows';

/** What the VS Code chat panel adds to the shared modal: the panel's own language, stored by the extension. */
export const PANEL_HOST_SETTINGS: HostSettings = {
  sections: [],
  rows: [
    {
      section: 'application',
      // Lazy like the modal itself, so the settings chunk stays out of the panel's first load.
      component: defineAsyncComponent(() => import('./PanelLanguageRow.vue')),
      rows: [{
        id: 'chat-panel-language',
        section: 'application',
        label: 'settingsModal.rows.panelLanguage.label',
        description: 'settingsModal.rows.panelLanguage.description',
      }],
    },
  ],
};
