import { escapeGlob } from '../../../shared/text-search';

// The Search view's glob edits from a result's context menu (VS Code's searchActionsFind.ts). They only rewrite the widget's
// include or exclude text; main parses the result with parseGlobList, so none of them can reach outside the project.

/** VS Code's extractSearchFilePattern: `*.` and everything after the name's first dot, or the whole name without one. */
export function fileTypeGlob(fileName: string): string {
  const dot = fileName.indexOf('.');
  return dot < 0 ? escapeGlob(fileName) : `*.${escapeGlob(fileName.slice(dot + 1))}`;
}

/** VS Code's mergeSearchPatternIfNotExists: appends `pattern` unless the list already holds it. */
export function mergeGlob(current: string, pattern: string): string {
  if (current.trim() === '') return pattern;
  const existing = current.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return existing.includes(pattern) ? current : `${current}, ${pattern}`;
}
