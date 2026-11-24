// Puts every dependency's stylesheet in the vendor cascade layer, which ranks after Tailwind's utilities and before the app's
// own rules and a theme's (docs/invariants.md "Theme CSS and trusted regions"). Tailwind's own CSS names its layers itself.
import { parse, type StyleSheet } from 'css-tree';
import type { Plugin } from 'vite';

// Vite has turned these imports into JavaScript before a transform sees them; `?inline` is still CSS.
const NOT_CSS_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
// None of these can sit inside a block: @charset opens the file, @import follows only layer statements and other imports,
// and @namespace comes before every rule.
const NOT_WRAPPABLE: ReadonlySet<string> = new Set(['import', 'charset', 'namespace']);

// Only plain `.css` modules: a dependency's preprocessor file or SFC <style> is not wrapped, and the build's unlayered-rule
// check (protected-layer.ts) is what refuses one.
export function isVendorStylesheet(id: string): boolean {
  if (NOT_CSS_QUERY.test(id)) return false;
  const file = id.split('?')[0]!.replace(/\\/g, '/');
  return file.endsWith('.css') && file.includes('/node_modules/') && !/\/node_modules\/(?:@tailwindcss\/[^/]+|tailwindcss)\//.test(file);
}

export function vendorLayered(css: string, id: string): string {
  const ast = parse(css, { parseAtrulePrelude: false, parseRulePrelude: false, parseValue: false }) as StyleSheet;
  const held = ast.children.toArray().find((node) => node.type === 'Atrule' && NOT_WRAPPABLE.has(node.name.toLowerCase()));
  if (held?.type === 'Atrule') throw new Error(`${id} holds an @${held.name.toLowerCase()}, which cannot sit inside @layer vendor`);
  return `@layer vendor {\n${css}\n}\n`;
}

export function vendorLayer(): Plugin {
  return {
    name: 'damocles-vendor-layer',
    enforce: 'pre',
    transform(code, id) {
      // no mappings: the wrapper moves every line, and null would say the code did not move
      return isVendorStylesheet(id) ? { code: vendorLayered(code, id), map: { mappings: '' } } : undefined;
    },
  };
}
