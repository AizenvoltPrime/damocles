// The folder a watch of (base, glob) subscribes to, shared by every host's file watcher so none watches more than the glob needs.
import * as path from 'node:path';
import { escapeGlob } from '../shared/text-search';

// A glob with no separator and no globstar matches direct children only, so a non-recursive watch covers it; this keeps a
// watch like (home, '.claude.json') from subscribing to the whole home tree.
export function isShallowGlob(glob: string): boolean {
  return !glob.includes('/') && !glob.includes('**');
}

/** relativePath as a glob that matches only itself; watchRoot takes each of its segments as static. */
export function literalGlob(relativePath: string): string {
  return escapeGlob(relativePath.replace(/\\/g, '\\\\')).replace(/[()|+@!]/g, '[$&]');
}

// A segment of literal text: characters that open no glob syntax (picomatch.scan's static ones), and the escapes literalGlob
// writes ([*], [(], \\).
const LITERAL_SEGMENT = /^(?:\[[\s\S]\]|\\[\s\S]|[^*?[{(\\])+$/;
const ESCAPED = /\[([\s\S])\]|\\([\s\S])/g;

/**
 * The directory to subscribe to for (base, glob): the glob's static prefix under base (its leading literal segments, escapes
 * undone), recursive only when the rest needs it; glob is that rest, matched below root.
 */
export function watchRoot(base: string, glob: string): { readonly root: string; readonly recursive: boolean; readonly glob: string } {
  const segments = glob.split('/');
  // a leading '!' negates the whole glob, so no part of it is a prefix
  const firstGlob = glob.startsWith('!') ? 0 : segments.findIndex((segment) => !LITERAL_SEGMENT.test(segment));
  // a glob literal throughout names one entry, watched from its folder
  const depth = firstGlob < 0 ? segments.length - 1 : firstGlob;
  const prefix = segments.slice(0, depth).map((segment) => segment.replace(ESCAPED, (_escape, bracketed?: string, slashed?: string) => bracketed ?? slashed ?? ''));
  const rest = segments.slice(depth).join('/');
  return { root: path.resolve(base, ...prefix), recursive: !isShallowGlob(rest), glob: rest };
}
