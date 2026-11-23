// css-tree's tokenizer, parser, walker and generator entries, typed from the root's types. The root entry is never imported: it loads the
// lexer's data through createRequire, which a bundled copy cannot run (docs/invariants.md "Theme CSS and trusted regions").
declare module 'css-tree/parser' {
  const parse: typeof import('css-tree').parse;
  export default parse;
}

declare module 'css-tree/walker' {
  const walk: typeof import('css-tree').walk;
  export default walk;
}

declare module 'css-tree/generator' {
  const generate: typeof import('css-tree').generate;
  export default generate;
}

declare module 'css-tree/tokenizer' {
  export const tokenize: typeof import('css-tree').tokenize;
  export const tokenTypes: typeof import('css-tree').tokenTypes;
}
