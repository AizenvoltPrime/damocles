import { inject, shallowRef, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import type { CharacterState, ShownCharacters } from '@shared/themes/characters';

// The project characters main last sent a page: the shell's from ShellState, the overlay's and the notifier's from
// OverlayState with each project's state, the theme render page's from its job. Main's data only: no theme CSS chooses or
// draws a character.
export interface PageCharacters {
  readonly shown: ShownCharacters | undefined;
  // by project key; a project absent here is idle
  readonly states: Readonly<Record<string, CharacterState>>;
  readonly selected: string | undefined;
}

export type PageCharactersInput = { readonly shown?: ShownCharacters | undefined; readonly states?: Readonly<Record<string, CharacterState>>; readonly selected?: string | undefined } | undefined;

/** Each page's root provides its characters; ProjectAvatar injects them. */
export const PAGE_CHARACTERS: InjectionKey<Readonly<Ref<PageCharacters>>> = Symbol('page-characters');

/** A page's characters and their setter, which leaves the value alone when main sends the same characters again. */
export function createPageCharacters(initial?: PageCharactersInput): { readonly characters: Readonly<ShallowRef<PageCharacters>>; set(next: PageCharactersInput): void } {
  const characters = shallowRef(pageCharactersOf(initial));
  // the held value as JSON, so a push is serialised once
  let held = JSON.stringify(characters.value);
  return {
    characters,
    set(next) {
      const value = pageCharactersOf(next);
      const text = JSON.stringify(value);
      if (text === held) return;
      held = text;
      characters.value = value;
    },
  };
}

function pageCharactersOf(next: PageCharactersInput): PageCharacters {
  return { shown: next?.shown, states: next?.states ?? {}, selected: next?.selected };
}

/** The page's characters, reactive; a component outside a page that provides them is a bug. */
export function usePageCharacters(): Readonly<Ref<PageCharacters>> {
  const characters = inject(PAGE_CHARACTERS, null);
  if (!characters) throw new Error('No page provides PAGE_CHARACTERS');
  return characters;
}
