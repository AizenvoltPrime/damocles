import type { Disposable } from '../../../platform/disposable';
import type { ClientSnapshots } from '../../../platform/remote-host';
import type { TerminalToggle, WindowService } from '../../../platform/window-service';
import type { CoreEndpoint, CoreInit } from '../../core-protocol';
import type { CorePanels } from './panels';

// a device the daemon has no terminal state of shows its toggle off
const NO_TERMINAL: TerminalToggle = { shown: false, shortcut: '' };

// Proxied; the terminal pane's state is mirrored, since the chat header reads it synchronously. clients: a daemon's core, which
// reads each device's state from its clientTerminal mirror.
export function createWindowProxy(endpoint: CoreEndpoint, init: CoreInit, panels: CorePanels, clients: ClientSnapshots | undefined): WindowService & Disposable {
  let terminal: TerminalToggle = init.mirrors.terminal;
  const subscription = clients ? undefined : endpoint.onMirror('terminal', (patch) => {
    terminal = patch;
  });
  return {
    chatBrowserPane: init.chatBrowserPane,
    createPanel: (options) => panels.create(options),
    // a desktop chat's own column is a new chat (main/platform/window-service.ts)
    createPanelInOwnColumn: async (options) => panels.create(options),
    openAppSettings: (section, account) => endpoint.emit('window.openAppSettings', { ...(section !== undefined ? { section } : {}), ...(account !== undefined ? { account } : {}) }),
    toggleTerminal: () => endpoint.emit('window.toggleTerminal', {}),
    terminalToggle: (clientId) => (clients ? (clientId === undefined ? undefined : clients.terminal(clientId)) ?? NO_TERMINAL : terminal),
    dispose: () => subscription?.dispose(),
  };
}
