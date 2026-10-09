import type { languages } from 'monaco-editor/editor/editor.api';

// A Search Editor body's language id; main tags the document with it.
export const SEARCH_RESULT_LANGUAGE_ID = 'search-result';

/**
 * VS Code's search-result grammar (extensions/search-result/syntaxes/generateTMLanguage.js, its plain-text rules) as Monarch
 * tokens named after the theme's existing rules: header keys, values and flags; a file line's folder, name and colon; a
 * match line's `12:` prefix apart from a context line's `12 ` one. Monarch matches only at the current position, so every
 * rule takes its whole line, and code after a prefix stays plain text (no per-language grammar).
 */
export const searchResultLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/(# (?:Query|Including|Excluding))(:)(.*)$/, ['keyword', 'delimiter', 'string']],
      [/(# Flags)(:)(.*)$/, ['keyword', 'delimiter', 'type']],
      [/(# ContextLines)(:)(.*)$/, ['keyword', 'delimiter', 'number']],
      [/(\s+)(\d+)(:)(.*)$/, ['', 'number', 'delimiter', '']],
      [/(\s+)(\d+)( {2}.*)$/, ['', 'comment', '']],
      // Linear on a long line without a colon: `.*[\\/]` backtracks over slashes only, and the name cannot cross one.
      [/(?=\S)((?:.*[\\/])?)([^\\/]+)(:)$/, ['comment', 'type', 'delimiter']],
      [/.*$/, ''],
    ],
  },
};
