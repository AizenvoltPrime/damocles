import * as path from 'node:path';
import { nativeImage, type NativeImage } from 'electron';

// 16 DIP is the menu bar and notification area size on macOS and Linux; Electron picks the scale for the display.
const TRAY_ICON_SIZE = 16;
// X11 sends the window manager only the 1x bitmap, which it scales to every size it shows; 256 px is the largest.
const LINUX_WINDOW_ICON_SIZE = 256;

// Windows loads an ICO at each exact size it asks for; a PNG becomes one full-size HICON that Windows shrinks unfiltered.
const windowsIcon = (resourceRoot: string): NativeImage => nativeImage.createFromPath(path.join(resourceRoot, 'resources', 'icon.ico'));

const pngIcon = (resourceRoot: string, size: number): NativeImage =>
  nativeImage.createFromPath(path.join(resourceRoot, 'resources', 'icon.png')).resize({ width: size, height: size, quality: 'best' });

/** The BrowserWindow icon on Windows and Linux; macOS shows the app bundle's icon instead. */
export function windowIcon(resourceRoot: string): NativeImage {
  return process.platform === 'win32' ? windowsIcon(resourceRoot) : pngIcon(resourceRoot, LINUX_WINDOW_ICON_SIZE);
}

export function trayIcon(resourceRoot: string): NativeImage {
  return process.platform === 'win32' ? windowsIcon(resourceRoot) : pngIcon(resourceRoot, TRAY_ICON_SIZE);
}
