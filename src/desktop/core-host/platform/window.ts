import type { Disposable } from '../../../platform/disposable';
import type { WindowService } from '../../../platform/window-service';
import type { CoreEndpoint, CoreInit, MirrorTopics } from '../../core-protocol';
import type { CorePanels } from './panels';

// Proxied; the terminal pane's state is mirrored, since the chat header reads it synchronously.
export function createWindowProxy(endpoint: CoreEndpoint, init: CoreInit, panels: CorePanels): WindowService & Disposable {
  let terminal: MirrorTopics['terminal'] = init.mirrors.terminal;
  const subscription = endpoint.onMirror('terminal', (patch) => {
    terminal = patch;
  });
  return {
    chatBrowserPane: init.chatBrowserPane,
    createPanel: (options) => panels.create(options),
    // a desktop chat's own column is a new chat (main/platform/window-service.ts)
    createPanelInOwnColumn: async (options) => panels.create(options),
    openAppSettings: (section, account) => endpoint.emit('window.openAppSettings', { ...(section !== undefined ? { section } : {}), ...(account !== undefined ? { account } : {}) }),
    toggleTerminal: () => endpoint.emit('window.toggleTerminal', {}),
    terminalToggle: () => terminal,
    dispose: () => subscription.dispose(),
  };
}
