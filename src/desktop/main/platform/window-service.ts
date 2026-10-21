import type { WindowService } from '../../../platform/window-service';

const overProtocol = (): never => {
  throw new Error('Damocles Core creates its panels over the core protocol');
};

// Every chat panel is a chat of the one window, created when Damocles Core asks over the core protocol
// (core-services/host-services.ts), so main's own platform creates none.
export function createDesktopWindowService(
  openAppSettings: WindowService['openAppSettings'],
  toggleTerminal: WindowService['toggleTerminal'],
  terminalToggle: WindowService['terminalToggle'],
): WindowService {
  return {
    chatBrowserPane: true,
    createPanel: overProtocol,
    createPanelInOwnColumn: async () => overProtocol(),
    openAppSettings,
    toggleTerminal,
    terminalToggle,
  };
}
