import type { SettingsStore } from '../../platform/settings-store';
import type { WalkSettings } from '../../platform/walk-settings';

const IGNORE_FILES = 'search.useIgnoreFiles';
const GLOBAL_IGNORE_FILES = 'search.useGlobalIgnoreFiles';
const PARENT_IGNORE_FILES = 'search.useParentIgnoreFiles';
const FOLLOW_SYMLINKS = 'search.followSymlinks';
const KEYS = [IGNORE_FILES, GLOBAL_IGNORE_FILES, PARENT_IGNORE_FILES, FOLLOW_SYMLINKS];

/** The walk's switches from VS Code's own search settings, as VS Code's search reads them; settings is VS Code's configuration. */
export function createVsCodeWalkSettings(settings: Pick<SettingsStore, 'get' | 'onDidChange'>): WalkSettings {
  return {
    read: () => ({
      ignore: {
        files: settings.get(IGNORE_FILES) !== false,
        global: settings.get(GLOBAL_IGNORE_FILES) !== false,
        parents: settings.get(PARENT_IGNORE_FILES) !== false,
      },
      followLinks: settings.get(FOLLOW_SYMLINKS) !== false,
    }),
    onDidChange: (cb) =>
      settings.onDidChange('search', (change) => {
        if (KEYS.some((key) => change.affects(key))) cb();
      }),
  };
}
