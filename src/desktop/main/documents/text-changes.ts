import type { EditorTextChange } from '../../preload/shell-channels';

/**
 * The text after Monaco's changes, applied in order, each against the text the ones before it left, as VS Code's
 * MirrorTextModel.onEvents applies them; undefined, with none applied, when one falls outside the text or the result is
 * longer than maxChars. The pieces are slices of text until the one join at the end, so a batch copies the text once.
 */
export function applyTextChanges(text: string, changes: readonly EditorTextChange[], maxChars: number): string | undefined {
  // In reverse order of the text: Monaco reports one edit's changes from the bottom up, so each splits the array's tail.
  const pieces = [text];
  let total = text.length;
  for (const change of changes) {
    const end = change.offset + change.length;
    if (end > total) return undefined;
    let first = pieces.length - 1;
    let firstStart = 0;
    while (first > 0 && firstStart + pieces[first]!.length <= change.offset) firstStart += pieces[first--]!.length;
    let last = first;
    let lastStart = firstStart;
    while (last > 0 && lastStart + pieces[last]!.length < end) lastStart += pieces[last--]!.length;
    const head = pieces[first]!.slice(0, change.offset - firstStart);
    const tail = pieces[last]!.slice(end - lastStart);
    pieces.splice(last, first - last + 1, ...[tail, change.text, head].filter((piece) => piece.length > 0));
    if (pieces.length === 0) pieces.push('');
    total += change.text.length - change.length;
  }
  return total > maxChars ? undefined : pieces.reverse().join('');
}
