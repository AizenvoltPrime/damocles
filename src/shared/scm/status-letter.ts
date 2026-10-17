// The letter VS Code's resource decoration shows for a git change; S marks a submodule, ! a conflict.
export type StatusLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '!' | 'S' | 'I';
export type StatusTone = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | 'renamed' | 'submodule' | 'ignored';

// Each letter has exactly one tone, so core's changes and a source that carries only the letter (a commit's files, a dialog's
// list, a chat's review) colour it alike.
export const LETTER_TONE: Readonly<Record<StatusLetter, StatusTone>> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  U: 'untracked',
  I: 'ignored',
  S: 'submodule',
  '!': 'conflict',
};
