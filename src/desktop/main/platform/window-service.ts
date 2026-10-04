import type { PanelHost, PanelOptions, WindowService } from '../../../platform/window-service';
import type { PanelViews } from '../views';

// Every chat panel is a chat of the one window, so a panel's "own column" is simply a new chat, which the owner creates
// and selects; a browser page opens in its owning chat's pane (PanelOptions.owner).
export function createDesktopWindowService(
  views: () => PanelViews,
  openChat: (options: PanelOptions) => PanelHost,
  openAppSettings: WindowService['openAppSettings'],
): WindowService {
  const create = (options: PanelOptions): PanelHost => (options.kind === 'chat' ? openChat(options) : views().create({ options }));
  return {
    chatBrowserPane: true,
    createPanel: create,
    createPanelInOwnColumn: async (options) => create(options),
    openAppSettings,
  };
}
