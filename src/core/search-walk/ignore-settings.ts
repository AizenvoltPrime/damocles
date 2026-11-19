import type { SettingsStore } from '../../platform/settings-store';
import type { WalkIgnore } from './walk';

/** The ignore switches the search.use*IgnoreFiles settings ask for, as VS Code's search reads them. */
export function walkIgnoreOf(settings: Pick<SettingsStore, 'get'>): WalkIgnore {
  return {
    files: settings.get('search.useIgnoreFiles') !== false,
    global: settings.get('search.useGlobalIgnoreFiles') !== false,
    parents: settings.get('search.useParentIgnoreFiles') !== false,
  };
}
