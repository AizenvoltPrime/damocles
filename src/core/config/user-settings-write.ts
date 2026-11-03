import type { SettingsStore } from '../../platform/settings-store';
import { errorTextOf, l } from '../l10n';
import { LocalizedError, type LocalizedArg } from '../../shared/localized-text';

/** The user settings file, by path where the host keeps one; VS Code's store names none. */
export function userSettingsFileName(settings: Pick<SettingsStore, 'scopeFile'>): LocalizedArg {
  return settings.scopeFile('user') ?? l('your user settings.json');
}

/** A failed write of a user setting, naming the settings file and the host's reason. */
export function userSettingWriteError(settings: Pick<SettingsStore, 'scopeFile'>, err: unknown): LocalizedError {
  return new LocalizedError(l('Could not save {0}: {1}', userSettingsFileName(settings), errorTextOf(err)), { cause: err });
}
