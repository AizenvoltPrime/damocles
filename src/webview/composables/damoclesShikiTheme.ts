import type { ThemeRegistration } from 'shiki';

export const DAMOCLES_SHIKI_THEME = 'damocles';

// Desktop code blocks (HostCapabilities.damoclesTheme): every color is a token the desktop host injects
// (src/desktop/main/theme.ts), so a theme switch recolors highlighted code without highlighting it again.
export const damoclesShikiTheme: ThemeRegistration = {
  name: DAMOCLES_SHIKI_THEME,
  type: 'dark',
  colors: {
    'editor.foreground': 'var(--d-text)',
    'editor.background': 'var(--d-code)',
  },
  tokenColors: [
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: 'var(--d-muted)' } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'], settings: { foreground: 'var(--s-com)' } },
    {
      scope: ['string', 'string.regexp', 'punctuation.definition.string', 'markup.inline.raw', 'markup.fenced_code', 'markup.raw'],
      settings: { foreground: 'var(--s-str)' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other', 'variable.other.constant', 'support.constant'],
      settings: { foreground: 'var(--s-num)' },
    },
    {
      scope: ['keyword', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python', 'storage', 'variable.language', 'entity.name.tag', 'markup.heading'],
      settings: { foreground: 'var(--s-kw)' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic', 'entity.other.attribute-name'],
      settings: { foreground: 'var(--s-fn)' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.other.inherited-class', 'support.type', 'support.class'],
      settings: { foreground: 'var(--s-type)' },
    },
    { scope: ['markup.bold', 'markup.heading'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inserted'], settings: { foreground: 'var(--d-success)' } },
    { scope: ['markup.deleted'], settings: { foreground: 'var(--d-danger)' } },
  ],
};
