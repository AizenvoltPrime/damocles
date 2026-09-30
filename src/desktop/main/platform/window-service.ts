import type { WindowService } from '../../../platform/window-service';
import type { PanelViews } from '../views';

// Every chat panel is a tab in the one window, so a panel's "own column" is simply a new tab; a browser page opens in
// its owning chat tab's pane (PanelOptions.owner).
export function createDesktopWindowService(views: () => PanelViews): WindowService {
  return {
    chatBrowserPane: true,
    createPanel: (options) => views().create({ options }),
    createPanelInOwnColumn: async (options) => views().create({ options }),
  };
}
