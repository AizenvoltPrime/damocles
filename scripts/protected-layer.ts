// The cascade layers src/webview/style.css names before Tailwind's (docs/invariants.md "Theme CSS and trusted regions"). Checked
// on the built CSS: Tailwind names its own properties layer ahead of them, and minifying turns the statement into blocks.
import { ident, parse, tokenize, tokenTypes, type CssNode, type List, type StyleSheet } from 'css-tree';
import type { Plugin } from 'vite';

export const PAGE_LAYERS = ['damocles-protected', 'theme', 'base', 'components', 'utilities', 'damocles-user'] as const;
const PROTECTED = PAGE_LAYERS[0];
const USER = PAGE_LAYERS[PAGE_LAYERS.length - 1]!;

interface Layers {
  // top-level layer names in the order they rank, lowest first: the order the stylesheet first names them in
  readonly order: readonly string[];
  // the layers holding an !important declaration, nested layers counting as their top-level one
  readonly important: ReadonlySet<string>;
  // an @import names layers and holds rules this check cannot read
  readonly imports: boolean;
}

// Read from the tokens, not the parsed rules: a rule shape the parser does not model (a nested rule it keeps as raw text)
// still counts, and a string that holds the words does not.
function holdsImportant(css: string): boolean {
  let bang = false;
  let found = false;
  tokenize(css, (type, start, end) => {
    if (type === tokenTypes.WhiteSpace || type === tokenTypes.Comment) return;
    if (bang && type === tokenTypes.Ident && ident.decode(css.slice(start, end)).toLowerCase() === 'important') found = true;
    bang = type === tokenTypes.Delim && css[start] === '!';
  });
  return found;
}

function layersOf(css: string): Layers {
  const order: string[] = [];
  const important = new Set<string>();
  let imports = false;
  const visit = (nodes: List<CssNode> | undefined): void => {
    nodes?.forEach((node) => {
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'layer') {
        const prelude = node.prelude?.type === 'Raw' ? node.prelude.value : '';
        // a dotted name sits in its first segment's layer; an unnamed block is a layer of its own, after every named one
        const names = prelude.split(',').map((name) => name.trim().split('.')[0]!).filter((name) => name !== '');
        const own = names[0] ?? `anonymous ${order.length}`;
        for (const name of names.length > 0 ? names : [own]) if (!order.includes(name)) order.push(name);
        if (node.block && node.loc && holdsImportant(css.slice(node.loc.start.offset, node.loc.end.offset))) important.add(own);
      } else if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') imports = true;
      else if (node.type === 'Atrule' || node.type === 'Rule') visit(node.block?.children);
    });
  };
  visit((parse(css, { positions: true, parseAtrulePrelude: false, parseRulePrelude: false, parseValue: false }) as StyleSheet).children);
  return { order, important, imports };
}

/**
 * Why `css` could let a theme's damocles-user rules beat the protected ones, or undefined when it cannot: it holds no @import
 * (a built stylesheet has them inlined), the page layers rank in PAGE_LAYERS' order with damocles-user last, a layer ranking
 * before damocles-protected holds no !important declaration, which would beat the protected ones, and damocles-protected
 * holds one, so the protected rules are there.
 */
export function protectedLayerRefusal(css: string): string | undefined {
  const { order, important, imports } = layersOf(css);
  if (imports) return 'it holds an @import, whose layers cannot be read';
  const ours = order.filter((name) => (PAGE_LAYERS as readonly string[]).includes(name));
  if (ours.join(', ') !== PAGE_LAYERS.join(', ')) return `it ranks the page layers ${ours.join(', ') || 'none'}, not ${PAGE_LAYERS.join(', ')}`;
  const earlier = order.slice(0, order.indexOf(PROTECTED)).filter((name) => important.has(name));
  if (earlier.length > 0) return `${earlier.join(', ')} ranks before ${PROTECTED} and holds an !important declaration`;
  const last = order[order.length - 1];
  if (last !== USER) return `${last} ranks after ${USER}`;
  return important.has(PROTECTED) ? undefined : `${PROTECTED} holds no !important declaration`;
}

/** Fails the build when the stylesheets an entry chunk named in `entries` loads, read in the order they load, are refused. */
export function protectedLayerOrder(entries: readonly string[]): Plugin {
  return {
    name: 'damocles-protected-layer-order',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const entry of entries) {
        const chunk = Object.values(bundle).find((file) => file.type === 'chunk' && file.isEntry && file.name === entry);
        const sheets = chunk?.type === 'chunk' ? [...chunk.viteMetadata?.importedCss ?? []] : [];
        const sources = sheets.map((sheet) => bundle[sheet]).map((asset) => (asset?.type === 'asset' && typeof asset.source === 'string' ? asset.source : undefined));
        if (sheets.length === 0 || sources.includes(undefined)) this.error(`the ${entry} entry loads no stylesheet emitted as text to check its layer order in`);
        const refusal = protectedLayerRefusal(sources.join('\n'));
        if (refusal !== undefined) this.error(`${sheets.join(', ')}, which the ${entry} entry loads: ${refusal}`);
      }
    },
  };
}
