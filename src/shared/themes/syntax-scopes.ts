// The TextMate scopes each syntax token colors. Must match the --s-* rules of damoclesShikiTheme
// (src/webview/composables/damoclesShikiTheme.ts); a VS Code theme import reads them back the other way (vscode-import.test.ts).
import type { SYNTAX_TOKENS } from './tokens';

export type SyntaxToken = (typeof SYNTAX_TOKENS)[number];

export const SYNTAX_SCOPES: Readonly<Record<SyntaxToken, readonly string[]>> = {
  '--s-com': ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'],
  '--s-str': ['string', 'string.regexp', 'punctuation.definition.string', 'markup.inline.raw', 'markup.fenced_code', 'markup.raw'],
  '--s-num': ['constant.numeric', 'constant.language', 'constant.character', 'constant.other', 'variable.other.constant', 'support.constant'],
  '--s-kw': ['keyword', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python', 'storage', 'variable.language', 'entity.name.tag', 'markup.heading'],
  '--s-fn': ['entity.name.function', 'support.function', 'meta.function-call.generic', 'entity.other.attribute-name'],
  '--s-type': ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.other.inherited-class', 'support.type', 'support.class'],
};

// VS Code semantic token types each syntax token takes, first found wins.
export const SEMANTIC_SCOPES: Readonly<Record<SyntaxToken, readonly string[]>> = {
  '--s-com': ['comment'],
  '--s-str': ['string', 'regexp'],
  '--s-num': ['number', 'enumMember'],
  '--s-kw': ['keyword'],
  '--s-fn': ['function', 'method'],
  '--s-type': ['type', 'class', 'interface', 'enum', 'struct', 'namespace'],
};
