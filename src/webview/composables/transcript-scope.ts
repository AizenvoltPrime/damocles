import type { InjectionKey } from 'vue';

/** Provided as true by a row of the main transcript: a tool card is a theme scope root only under one, never in a dialog. */
export const IN_TRANSCRIPT: InjectionKey<boolean> = Symbol('inTranscript');
