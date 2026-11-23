import { shallowRef, type ShallowRef } from 'vue';
import type { CharacterState, ShownCharacters } from '@shared/themes/characters';

// The project characters main last sent this page: the shell's from ShellState, the overlay's and the notifier's from
// OverlayState with each project's state. Main's data only: no theme CSS chooses or draws a character.
export interface PageCharacters {
  readonly shown: ShownCharacters | undefined;
  // by project key; a project absent here is idle
  readonly states: Readonly<Record<string, CharacterState>>;
  readonly selected: string | undefined;
}

const characters: ShallowRef<PageCharacters> = shallowRef({ shown: undefined, states: {}, selected: undefined });
// the held value as JSON, so a push is serialised once
let held = JSON.stringify(characters.value);

export function setPageCharacters(next: { readonly shown?: ShownCharacters | undefined; readonly states?: Readonly<Record<string, CharacterState>>; readonly selected?: string | undefined } | undefined): void {
  const value: PageCharacters = { shown: next?.shown, states: next?.states ?? {}, selected: next?.selected };
  const text = JSON.stringify(value);
  if (text === held) return;
  held = text;
  characters.value = value;
}

/** The page's characters, reactive: a render that reads it reruns when main sends others. */
export function pageCharacters(): PageCharacters {
  return characters.value;
}
