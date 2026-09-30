import { EXTENSION_EXTERNALS } from './extension-externals.mjs';

// The desktop main bundle's esbuild `external` list: the extension's externals minus the VS Code host module, plus the Electron runtime, the native watcher and the updater.
export const DESKTOP_EXTERNALS = [
  ...EXTENSION_EXTERNALS.filter((name) => name !== 'vscode'),
  'electron',
  '@parcel/watcher',
  'electron-updater',
];
