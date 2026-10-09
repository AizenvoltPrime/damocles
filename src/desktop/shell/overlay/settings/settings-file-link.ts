import type { InjectionKey } from 'vue';
import type { SettingsFileScope } from '@shared/types/messages';

/** Opens a settings file in an editor tab and closes the modal; `key` places the editor at that setting. */
export type EditSettingsFile = (scope: SettingsFileScope, key?: string) => void;

export const EDIT_SETTINGS_FILE: InjectionKey<EditSettingsFile> = Symbol('edit-settings-file');
