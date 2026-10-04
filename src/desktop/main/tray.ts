import { Menu, nativeImage, Tray } from 'electron';
import type { DesktopLocalizationService } from './platform/localization-service';

export const TRAY_IDS = {
  toggleWindow: 'damocles.tray.toggleWindow',
  newChat: 'damocles.tray.newChat',
  quit: 'damocles.tray.quit',
} as const;

export interface TrayActions {
  // true when the window exists and is visible
  windowVisible(): boolean;
  toggleWindow(): void;
  newChat(): void;
  quit(): void;
}

// 16 DIP is the menu bar and notification area size on every platform; Electron picks the scale for the display.
const TRAY_ICON_SIZE = 16;

/** The notification-area icon. Linux app indicators never report a click, so the owner calls relocalize() on every window show and hide to keep the toggle label true. */
export class AppTray {
  private readonly tray: Tray;
  private readonly actions: TrayActions;
  private readonly l10n: DesktopLocalizationService;

  constructor(iconPath: string, actions: TrayActions, l10n: DesktopLocalizationService) {
    this.actions = actions;
    this.l10n = l10n;
    this.tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE }));
    this.relocalize();
    this.tray.on('click', () => actions.toggleWindow());
  }

  relocalize(): void {
    this.tray.setToolTip('Damocles');
    this.tray.setContextMenu(this.menu());
  }

  menu(): Menu {
    const t = (label: string): string => this.l10n.t(label);
    return Menu.buildFromTemplate([
      {
        id: TRAY_IDS.toggleWindow,
        label: this.actions.windowVisible() ? t('Hide Damocles') : t('Show Damocles'),
        click: () => this.actions.toggleWindow(),
      },
      { id: TRAY_IDS.newChat, label: t('New Chat'), click: () => this.actions.newChat() },
      { type: 'separator' },
      { id: TRAY_IDS.quit, label: t('Quit Damocles'), click: () => this.actions.quit() },
    ]);
  }

  dispose(): void {
    this.tray.destroy();
  }
}
