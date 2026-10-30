import { malformedLocalizedText } from '../../shared/localized-paths';
import { CoreProtocolError } from './endpoint';
import { MAX_MESSAGE_CHARS } from './messages';
import type { ScmCall, WorktreeCall } from './scm-calls';

// Where a scm.call or worktrees.call result carries LocalizedText that main renders (localized-paths.ts paths).
export const SCM_CALL_LOCALIZED_TEXT: { readonly [M in ScmCall]?: readonly string[] } = {
  mergeInputs: ['.labels.base.title', '.labels.current.title', '.labels.incoming.title'],
};

export const WORKTREE_CALL_LOCALIZED_TEXT: { readonly [M in WorktreeCall]?: readonly string[] } = {
  mergeInto: ['[kind="refused"].message'],
  rebaseOnto: ['[kind="refused"].message'],
  updateFrom: ['[kind="refused"].message'],
};

/** `result` once its LocalizedText parses; a core that sent other text fails the call here, before main renders any of it. */
export function parsedCallText<T>(request: 'scm.call' | 'worktrees.call', method: string, paths: readonly string[] | undefined, result: T): T {
  const malformed = paths === undefined ? undefined : malformedLocalizedText(result, paths, MAX_MESSAGE_CHARS);
  if (malformed !== undefined) throw new CoreProtocolError(`Core protocol violation: result of ${request} ${method}, whose ${malformed} is not LocalizedText`);
  return result;
}
