// The resources a design page or stylesheet loads, as DesignCheck checks them and the render inputs hash them (D86).
import * as path from 'node:path';
import { parseHTML } from 'linkedom';
import { cssResourceRefs, declarationsOf, scanCss } from './css-scan';

/** The attributes whose value is a resource an element loads; `srcset` lists several. */
const RESOURCE_ATTRIBUTES = ['src', 'srcset', 'poster', 'data'];
/** SVG elements whose `href` (or the older `xlink:href`) loads a resource, lowercased: `<use>`, `<image>`, `<feImage>`. */
export const SVG_RESOURCE_TAGS: ReadonlySet<string> = new Set(['use', 'image', 'feimage']);
// a script of one of these types (or none) runs; any other type is a data block
const SCRIPT_TYPES: ReadonlySet<string> = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'text/jscript', 'text/livescript', 'application/x-javascript', 'application/x-ecmascript', 'text/x-javascript', 'text/x-ecmascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5']);

/** What the scanner reads of an element. */
export interface RefElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}

/** A resource `ref` as written; `stylesheet`: a `<link>`'s href, which may also be tokens.css. */
export interface ElementRef {
  readonly ref: string;
  readonly stylesheet: boolean;
}

/** Whether `ref` names a scheme or a network path, so it is no file of the design. */
export function isRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref.trim()) || ref.trim().startsWith('//');
}

/**
 * The design-folder-relative file `ref` names, resolved against the directory of `from` (itself design-folder-relative), with
 * each `\` read as `/` (as Chromium's URL parser reads the design scheme), its query and fragment dropped and its percent
 * escapes decoded once, as the design servers decode a path; undefined for a remote, empty, fragment-only or rooted ref, a
 * malformed escape, an escaped `\` (which the servers refuse), or one that leaves the folder.
 */
export function designRefPath(from: string, ref: string): string | undefined {
  const written = ref.trim().replaceAll('\\', '/').split(/[?#]/, 1)[0] ?? '';
  if (written === '' || isRemoteRef(written)) return undefined;
  const bare = decodedOnce(written);
  if (bare === undefined || bare.startsWith('/') || bare.includes('\\')) return undefined;
  const relPath = path.posix.normalize(path.posix.join(path.posix.dirname(from), bare));
  if (relPath === '..' || relPath.startsWith('../') || path.posix.isAbsolute(relPath)) return undefined;
  return relPath;
}

/** `text` with its percent escapes decoded, or undefined for a malformed escape, which names no file. */
function decodedOnce(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

/**
 * The resources `element` loads through its attributes: src, srcset, poster, data, a `<link>`'s href, and the href or
 * xlink:href of an SVG `<use>`, `<image>` or `<feImage>`.
 */
export function elementRefs(element: RefElement): ElementRef[] {
  const refs: ElementRef[] = [];
  for (const name of RESOURCE_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const listed = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value];
    for (const ref of listed) refs.push({ ref, stylesheet: false });
  }
  const tag = element.tagName.toLowerCase();
  if (tag === 'link') {
    const href = element.getAttribute('href');
    if (href !== null) refs.push({ ref: href, stylesheet: true });
  }
  if (SVG_RESOURCE_TAGS.has(tag)) {
    for (const name of ['href', 'xlink:href']) {
      const value = element.getAttribute(name);
      if (value !== null) refs.push({ ref: value, stylesheet: false });
    }
  }
  return refs;
}

/** Whether `element` runs script: a `<script>`, inline or `src`, classic or module (not a data block), or an inline `on*` handler. */
export function runsScript(element: RefElement & { readonly attributes?: ArrayLike<{ readonly name: string }> }): boolean {
  if (element.tagName.toLowerCase() === 'script') return SCRIPT_TYPES.has((element.getAttribute('type') ?? '').trim().toLowerCase());
  return Array.from(element.attributes ?? []).some((attribute) => attribute.name.toLowerCase().startsWith('on'));
}

/** What a stylesheet's text loads: its `@import`s, which are stylesheets themselves, and the resources of its declarations. */
export function stylesheetRefs(css: string): { readonly imports: readonly string[]; readonly resources: readonly string[] } {
  const { declarations, imports } = scanCss(css);
  return { imports, resources: declarations.flatMap((declaration) => cssResourceRefs(declaration.value)) };
}

/**
 * What page `html` loads: its elements' resource attributes and their style attributes' resources (`refs`), its `<style>`s'
 * `@import`s (`imports`) and declarations' resources (`refs`), and whether it runs any script.
 */
export function pageRefs(html: string): { readonly refs: string[]; readonly imports: string[]; readonly scripted: boolean } {
  const { document } = parseHTML(html) as unknown as { document: { querySelectorAll(selector: string): ArrayLike<RefElement & { readonly attributes: ArrayLike<{ readonly name: string }> }> } };
  const refs: string[] = [];
  const imports: string[] = [];
  let scripted = false;
  for (const element of Array.from(document.querySelectorAll('*'))) {
    refs.push(...elementRefs(element).map((entry) => entry.ref));
    scripted ||= runsScript(element);
    const style = element.getAttribute('style');
    if (style !== null) refs.push(...declarationsOf(style, 1).flatMap((declaration) => cssResourceRefs(declaration.value)));
    if (element.tagName.toLowerCase() === 'style') {
      const sheet = stylesheetRefs(element.textContent ?? '');
      imports.push(...sheet.imports);
      refs.push(...sheet.resources);
    }
  }
  return { refs, imports, scripted };
}
