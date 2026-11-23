import type { PinEdit, ProjectsFile } from '@shared/themes/characters';
import type { CharacterSet } from '@shared/themes/schema';

/** A project's pin in the theme being edited: a character of its set (null: automatic) and the name of the one kept in every theme. */
export interface PinChoice {
  readonly character: string | null;
  readonly every: string | null;
}

/** Each project's pin for `themeId` as projects.json holds it. */
export function pinChoices(file: ProjectsFile | undefined, themeId: string, keys: readonly string[]): Record<string, PinChoice> {
  return Object.fromEntries(keys.map((key) => {
    const pin = file?.pins[key];
    return [key, { character: pin?.byTheme?.[themeId] ?? null, every: pin?.everyTheme?.name ?? null }];
  }));
}

/** What Save changes in projects.json: each project whose choice differs from what the file held. */
export function pinEdits(before: Readonly<Record<string, PinChoice>>, now: Readonly<Record<string, PinChoice>>): PinEdit[] {
  return Object.entries(now).flatMap(([projectKey, choice]): PinEdit[] => {
    const was = before[projectKey] ?? { character: null, every: null };
    const character = choice.character !== was.character ? { character: choice.character } : {};
    const everyTheme = choice.every !== was.every ? { everyTheme: choice.every } : {};
    return Object.keys(character).length + Object.keys(everyTheme).length > 0 ? [{ projectKey, ...character, ...everyTheme }] : [];
  });
}

/** The pins with every character the set lacks as automatic, which is how core reads them; `pins` itself when all are in the set. */
export function validPins(pins: Readonly<Record<string, PinChoice>>, set: CharacterSet | undefined): Readonly<Record<string, PinChoice>> {
  const names = new Set((set?.characters ?? []).map((character) => character.name));
  const stale = Object.entries(pins).filter(([, choice]) => choice.character !== null && !names.has(choice.character));
  return stale.length === 0 ? pins : { ...pins, ...Object.fromEntries(stale.map(([key, choice]) => [key, { ...choice, character: null }])) };
}
