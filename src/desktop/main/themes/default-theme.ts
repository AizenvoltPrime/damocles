// The first launch on a computer with no ~/.damocles prefers System colors (docs/invariants.md "Desktop themes").
import * as fs from 'node:fs';
import { DEFAULT_THEME_ID } from '../../../shared/themes/builtin';
import { THEMES_DARK_SETTING, THEMES_LIGHT_SETTING } from '../../local-services/desktop-configuration';

// The global-state key that says this install's default theme was decided, so no later launch decides it again.
export const DEFAULT_DECIDED_KEY = 'damocles.desktop.themes.defaultDecided';
const DESKTOP_SETTINGS_PREFIX = 'damocles.desktop.';

export interface SeedDefaultDeps {
  // ~/.damocles was there when this launch started (homeExisted)
  readonly homeExisted: boolean;
  // each key-value state file was absent (ENOENT) when this run first read it; false for a present, corrupt or refused file
  readonly stateAbsent: { readonly global: boolean; readonly workspace: boolean };
  // the global memento, which holds the marker
  readonly state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> };
  readonly settings: {
    updateUserUnless(values: Readonly<Record<string, unknown>>, keep: (current: Readonly<Record<string, unknown>>) => boolean): Promise<boolean>;
  };
  log(line: string): void;
}

// seeded: both preferred looks now name System colors; existing: not a new install, nothing written but the marker;
// decided: the marker was set by an earlier launch; failed: the settings write failed, so the user stays on Damocles
export type SeedOutcome = 'seeded' | 'existing' | 'decided' | 'failed';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether anything is at `dir`; any error but ENOENT counts as there. Read before anything of this launch can create it. */
export function homeExisted(dir: string): boolean {
  try {
    // eslint-disable-next-line damocles/no-sync -- one read at main's start, before any code of this launch can create the folder
    fs.lstatSync(dir);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Decides this install's default theme once. A new install (no ~/.damocles at the start of this launch, no key-value state
 * file) gets System colors for both looks; any other keeps what it shows. Never rejects.
 */
export async function seedSystemDefault(deps: SeedDefaultDeps): Promise<SeedOutcome> {
  if (deps.state.get<unknown>(DEFAULT_DECIDED_KEY) === true) return 'decided';
  const mark = (): Promise<void> => deps.state.update(DEFAULT_DECIDED_KEY, true).catch((err: unknown) => {
    deps.log(`[themes] the default theme's marker could not be written: ${errorText(err)}`);
  });
  if (deps.homeExisted || !deps.stateAbsent.global || !deps.stateAbsent.workspace) {
    await mark();
    return 'existing';
  }
  let written: boolean;
  try {
    written = await deps.settings.updateUserUnless(
      { [THEMES_DARK_SETTING]: DEFAULT_THEME_ID, [THEMES_LIGHT_SETTING]: DEFAULT_THEME_ID },
      (current) => Object.keys(current).some((key) => key.startsWith(DESKTOP_SETTINGS_PREFIX)),
    );
  } catch (err) {
    deps.log(`[themes] System colors could not be made the default theme, so Damocles stays: ${errorText(err)}`);
    return 'failed';
  }
  await mark();
  if (!written) return 'existing';
  deps.log('[themes] a new install: System colors is the default theme');
  return 'seeded';
}
