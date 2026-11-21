import type { SettingsStore } from '../../platform/settings-store';
import type { WalkSettings } from '../../platform/walk-settings';
import {
  SEARCH_FOLLOW_SYMLINKS_SETTING,
  SEARCH_USE_GLOBAL_IGNORE_FILES_SETTING,
  SEARCH_USE_IGNORE_FILES_SETTING,
  SEARCH_USE_PARENT_IGNORE_FILES_SETTING,
} from './desktop-configuration';

const KEYS = [SEARCH_USE_IGNORE_FILES_SETTING, SEARCH_USE_GLOBAL_IGNORE_FILES_SETTING, SEARCH_USE_PARENT_IGNORE_FILES_SETTING, SEARCH_FOLLOW_SYMLINKS_SETTING];

/** The walk's switches from desktop's damocles.desktop.search.* settings in settings, the store of the process that walks. */
export function createDesktopWalkSettings(settings: Pick<SettingsStore, 'get' | 'onDidChange'>): WalkSettings {
  return {
    read: () => ({
      ignore: {
        files: settings.get(SEARCH_USE_IGNORE_FILES_SETTING) !== false,
        global: settings.get(SEARCH_USE_GLOBAL_IGNORE_FILES_SETTING) !== false,
        parents: settings.get(SEARCH_USE_PARENT_IGNORE_FILES_SETTING) !== false,
      },
      followLinks: settings.get(SEARCH_FOLLOW_SYMLINKS_SETTING) !== false,
    }),
    onDidChange: (cb) =>
      settings.onDidChange('damocles.desktop.search', (change) => {
        if (KEYS.some((key) => change.affects(key))) cb();
      }),
  };
}
