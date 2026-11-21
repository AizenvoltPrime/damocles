import type { SettingsStore } from '../../platform/settings-store';
import { SEARCH_USE_GLOBAL_IGNORE_FILES_SETTING, SEARCH_USE_IGNORE_FILES_SETTING, SEARCH_USE_PARENT_IGNORE_FILES_SETTING } from '../local-services/desktop-configuration';

// The search keys the desktop app read before they became its own settings, each with the key it moved to; VS Code keeps its own.
const RENAMED_SEARCH_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['search.useIgnoreFiles', SEARCH_USE_IGNORE_FILES_SETTING],
  ['search.useGlobalIgnoreFiles', SEARCH_USE_GLOBAL_IGNORE_FILES_SETTING],
  ['search.useParentIgnoreFiles', SEARCH_USE_PARENT_IGNORE_FILES_SETTING],
];

/**
 * Moves each renamed search key of the desktop user settings file to its new key, as VS Code's ConfigurationMigrationRegistry
 * moves a renamed setting: the value is written only where the new key is unset, then the old key is removed, so a later start
 * finds nothing to move. A failed write rejects and leaves the old key for the next start.
 */
export async function migrateRenamedSearchSettings(settings: Pick<SettingsStore, 'inspect' | 'update'>, log: (line: string) => void): Promise<void> {
  for (const [old, renamed] of RENAMED_SEARCH_SETTINGS) {
    const value = settings.inspect<unknown>(old).userValue;
    if (value === undefined) continue;
    const kept = settings.inspect<unknown>(renamed).userValue !== undefined;
    if (!kept) await settings.update(renamed, value, 'user');
    await settings.update(old, undefined, 'user');
    log(kept ? `[Migration] Removed ${old}, which ${renamed} already sets` : `[Migration] Moved ${old} to ${renamed}`);
  }
}
