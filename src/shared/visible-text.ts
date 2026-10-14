// C0 and C1 controls, the bidi marks, embeddings, overrides and isolates, the zero-width characters and the line and paragraph
// separators, which can make a file or ref name read as another.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Repository text (a path, a branch) as Damocles shows it: each control or bidi character as its visible `\u{…}` escape. */
export const visibleText = (text: string): string =>
  text.replace(HIDDEN_CHARACTERS, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`);
