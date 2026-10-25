// The settings overlay tab a message came from, for the setters it reaches: a daemon's core lets a user-home setter write
// its machine file only from the host tab.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContributedConfiguration } from '../config/contributed-configuration';
import type { SettingsScope } from '../../platform/settings-store';
import type { SettingsViewScope } from './types';

const current = new AsyncLocalStorage<SettingsViewScope>();

export function withSettingsViewScope<T>(scope: SettingsViewScope | undefined, run: () => T): T {
  return scope === undefined ? run() : current.run(scope, run);
}

/**
 * The keys a settings tab may write, which its view lists: user every key, the host tab all but the client-only ones, the
 * project tab the resource scoped keys a project file may hold. Each must match the file settingsViewWriteScope writes.
 */
export function writableKeysOf(scope: SettingsViewScope, contributed: ContributedConfiguration): string[] {
  if (scope === 'user') return [...contributed.keys];
  if (scope === 'machine') return contributed.keys.filter((key) => !contributed.clientOnlyKeys.has(key));
  return contributed.keys.filter((key) => contributed.resourceKeys.has(key) && !contributed.userOnlyKeys.has(key));
}

/** The tab of the settings view whose message is being handled; undefined for every other edit. */
export function settingsViewScope(): SettingsViewScope | undefined {
  return current.getStore();
}

/**
 * The file a setter writes from a scope tab, the one its banner names, whatever the setter's home and whichever file holds
 * the value now: the User tab this computer's user file, the host tab its host's machine file (a daemon's core's user
 * scope), the Project tab a per-folder key's project file. Undefined elsewhere, where the setter's home scope applies.
 */
export function settingsViewWriteScope(perFolder: boolean): SettingsScope | undefined {
  const scope = settingsViewScope();
  if (scope === 'user' || scope === 'machine') return 'user';
  if (scope === 'project' && perFolder) return 'project';
  return undefined;
}
