import { join } from 'node:path';

export const DEV_PRODUCT_NAME = 'Damocles Dev';

/**
 * The Electron build the unpackaged app runs on under Windows: the copy brand-dev-electron.mjs writes, whose electron.exe
 * carries Damocles' icon. It keeps the name electron.exe, because app.isPackaged is true for any other name, and sits in a
 * folder of its own, because the shell caches an icon by path. Launchers select it with ELECTRON_OVERRIDE_DIST_PATH, so
 * require('electron'), and with it Playwright, returns its binary.
 */
export function devElectronDist(electronPackageDir) {
  return join(electronPackageDir, 'dist-damocles-dev');
}
