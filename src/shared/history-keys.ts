/** A key press as main's before-input-event and a renderer's KeyboardEvent both describe it. */
export interface HistoryKey {
  readonly code: string;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** The browser's Back and Forward keys: Cmd+[ and Cmd+] on macOS, Alt+Left and Alt+Right elsewhere; undefined for any other key. */
export function historyStepOf(key: HistoryKey, mac: boolean): 'back' | 'forward' | undefined {
  if (key.shift) return undefined;
  if (mac) {
    if (!key.meta || key.alt || key.control) return undefined;
    return key.code === 'BracketLeft' ? 'back' : key.code === 'BracketRight' ? 'forward' : undefined;
  }
  if (!key.alt || key.control || key.meta) return undefined;
  return key.code === 'ArrowLeft' ? 'back' : key.code === 'ArrowRight' ? 'forward' : undefined;
}
