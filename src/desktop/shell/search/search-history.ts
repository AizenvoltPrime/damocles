import { MAX_SEARCH_HISTORY } from '../../../shared/text-search';

// VS Code's input history (base/common/history.ts HistoryNavigator over base/common/navigator.ts ArrayNavigator, driven by
// base/browser/ui/inputbox/inputBox.ts HistoryInputBox): oldest first, a re-added value moves to the end, 100 entries.

export interface InputHistory {
  /** Oldest first, as main persists them. */
  entries(): readonly string[];
  /** HistoryInputBox.addToHistory: a non-empty value not already the current entry, unless `always`. */
  add(value: string, always?: boolean): void;
  /** Up: the older value to show (the oldest stays), or undefined while the history is empty. */
  previous(value: string): string | undefined;
  /** Down: the value to show; past the newest entry the input clears. */
  next(value: string): string;
  clear(): void;
}

export function createInputHistory(initial: readonly string[] = []): InputHistory {
  let elements: string[] = [];
  // ArrayNavigator's index over elements: -1 before the first, elements.length past the last (nowhere)
  let index = 0;

  function changed(): void {
    if (elements.length > MAX_SEARCH_HISTORY) elements = elements.slice(elements.length - MAX_SEARCH_HISTORY);
    index = elements.length;
  }

  function push(value: string): void {
    elements = elements.filter((entry) => entry !== value);
    elements.push(value);
    changed();
  }

  const current = (): string | null => (index === -1 || index === elements.length ? null : elements[index]!);
  const forward = (): string | null => {
    index = Math.min(index + 1, elements.length);
    return current();
  };
  // Past the first entry it gives null, and previous() falls back to first(), as HistoryInputBox.getPreviousValue does.
  const back = (): string | null => {
    index = Math.max(index - 1, -1);
    return current();
  };
  const first = (): string | null => {
    index = 0;
    return current();
  };

  // HistoryInputBox.getCurrentValue: from nowhere it reads the last entry and stays nowhere.
  function currentValue(): string | null {
    const value = current();
    if (value !== null) return value;
    index = elements.length - 1;
    const last = current();
    forward();
    return last;
  }

  function add(value: string, always = false): void {
    if (value !== '' && (always || value !== currentValue())) push(value);
  }

  for (const entry of initial) push(entry);

  return {
    entries: () => elements,
    add,
    previous(value) {
      if (!elements.includes(value)) add(value);
      let previous = back() ?? first();
      if (previous !== null && previous === value) previous = back() ?? first();
      return previous ?? undefined;
    },
    next(value) {
      if (!elements.includes(value)) add(value);
      let next = forward();
      if (next !== null && next === value) next = forward();
      return next ?? '';
    },
    clear() {
      elements = [];
      changed();
    },
  };
}
