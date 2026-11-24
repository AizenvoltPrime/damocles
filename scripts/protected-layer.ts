// The cascade layers src/webview/style.css names before Tailwind's (docs/invariants.md "Theme CSS and trusted regions"). Checked
// on the built CSS: Tailwind names its own properties layer ahead of them, and minifying turns the statement into blocks.
import { ident, parse, tokenize, tokenTypes, type CssNode, type List, type StyleSheet } from 'css-tree';
import type { Plugin } from 'vite';

export const PAGE_LAYERS = ['damocles-protected', 'theme', 'base', 'components', 'utilities', 'vendor', 'app', 'damocles-user'] as const;
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

// Their blocks hold keyframe selectors or descriptors, never a rule that styles an element.
const NO_STYLE_RULES: ReadonlySet<string> = new Set(['layer', 'font-face', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'page']);
const KEYFRAMES = /^(?:-[a-z]+-)?keyframes$/;
const holdsNoStyleRule = (atrule: string): boolean => NO_STYLE_RULES.has(atrule) || KEYFRAMES.test(atrule);

function firstUnlayeredRule(nodes: List<CssNode> | undefined): string | undefined {
  let found: string | undefined;
  nodes?.some((node) => {
    if (node.type === 'Rule') found = node.prelude.type === 'Raw' ? node.prelude.value.trim() : '';
    else if (node.type === 'Atrule' && !holdsNoStyleRule(node.name.toLowerCase())) found = firstUnlayeredRule(node.block?.children);
    return found !== undefined;
  });
  return found;
}

/**
 * Why `css` holds a rule outside every cascade layer, which would beat every layer a theme's CSS is in, or undefined when it
 * holds none: a style rule at the top level or inside a top-level conditional rule (@media, @supports, @container, @scope,
 * @starting-style) is refused, and @font-face, @property, @keyframes, @counter-style and layer statements are not.
 */
export function unlayeredRuleRefusal(css: string): string | undefined {
  const ast = parse(css, { parseAtrulePrelude: false, parseRulePrelude: false, parseValue: false }) as StyleSheet;
  const selector = firstUnlayeredRule(ast.children);
  return selector === undefined ? undefined : `it holds a rule outside every layer: ${selector}`;
}

// Tailwind's own layer of custom property fallbacks, which its build names ahead of the page's.
const KNOWN_LAYERS: ReadonlySet<string> = new Set([...PAGE_LAYERS, 'properties']);

// Layers at the top level or inside a conditional rule; a layer inside another layer ranks within it and is not read.
function firstForeignLayer(nodes: List<CssNode> | undefined): string | undefined {
  let found: string | undefined;
  nodes?.some((node) => {
    if (node.type !== 'Atrule') return false;
    const name = node.name.toLowerCase();
    if (name === 'import') found = 'it holds an @import, whose layers and rules cannot be read';
    else if (name === 'layer') {
      const names = (node.prelude?.type === 'Raw' ? node.prelude.value : '').split(',').map((layer) => layer.trim().split('.')[0]!).filter((layer) => layer !== '');
      const foreign = names.find((layer) => !KNOWN_LAYERS.has(layer));
      if (names.length === 0) found = 'it holds a layer without a name, which ranks after every named one';
      else if (foreign !== undefined) found = `it names the layer ${foreign}, which is not a page layer`;
    } else found = firstForeignLayer(node.block?.children);
    return found !== undefined;
  });
  return found;
}

/**
 * Why `css` could rank a layer after damocles-user, whose rules would beat a theme's, or undefined when it cannot: it holds
 * no @import, no layer without a name and no layer but the page's own and Tailwind's properties, whichever stylesheet of the
 * page loads first.
 */
export function foreignLayerRefusal(css: string): string | undefined {
  return firstForeignLayer((parse(css, { parseAtrulePrelude: false, parseRulePrelude: false, parseValue: false }) as StyleSheet).children);
}

/**
 * Fails the build when the stylesheets an entry chunk named in `entries` loads, read in the order they load, are refused, or
 * when any stylesheet in the bundle, a lazy chunk's included, holds a rule outside every layer or could rank a layer after
 * damocles-user.
 */
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
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
        const source = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        const refusal = unlayeredRuleRefusal(source) ?? foreignLayerRefusal(source);
        if (refusal !== undefined) this.error(`${file.fileName}: ${refusal}`);
      }
    },
  };
}
