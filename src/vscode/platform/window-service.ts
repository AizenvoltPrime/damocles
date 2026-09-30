import type { WindowService } from '../../platform/window-service';
import { createPanel, createPanelInOwnColumn } from '../panels/panel-factory';

export function createVsCodeWindowService(): WindowService {
  return { chatBrowserPane: false, createPanel, createPanelInOwnColumn };
}
