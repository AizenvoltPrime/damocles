import type { WindowService } from '../../platform/window-service';
import { createPanel, createPanelInOwnColumn } from '../panels/panel-factory';

export function createVsCodeWindowService(): WindowService {
  return {
    chatBrowserPane: false,
    createPanel,
    createPanelInOwnColumn,
    openAppSettings: () => {
      throw new Error('VS Code shows the settings modal inside the chat panel (settingsInPanel)');
    },
  };
}
