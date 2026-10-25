// A pty's screen kept in the pty host, so a shell page that loads again shows it: adapted from VS Code's XtermSerializer
// (src/vs/platform/terminal/node/ptyService.ts, MIT, see THIRD-PARTY-NOTICES.md).
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal, type IMarker } from '@xterm/headless';
import { MAX_TERMINAL_SCREEN_CHARS, MAX_TERMINAL_SCREEN_MARKS } from '../preload/terminal-channels';
import type { ScreenMark } from './protocol';

// The OSC 633 types whose line main's command marks need: prompt start, command start, executed and finished.
const MARKED_SEQUENCE = /^[ABCD](?:;|$)/;
// SerializeAddon's longest output for one cell: an SGR changing a truecolor foreground and background and every attribute,
// the cursor moves that write back the empty cells before it, and a surrogate pair. Only a cell of combining marks is longer.
const MAX_SERIALIZED_CELL_CHARS = 80;

export interface ScreenSnapshot {
  readonly data: string;
  readonly cols: number;
  readonly rows: number;
  readonly marks: readonly ScreenMark[];
  // the OSC 633 sequences the screen parsed, which is the index of the next one
  readonly sequences: number;
}

export interface PtyScreen {
  // parsed: once xterm has consumed the data; never after a dispose
  write(data: string, parsed?: () => void): void;
  resize(cols: number, rows: number): void;
  // after every write so far, as the shell's Clear came after the output it had shown
  clear(): void;
  setScrollback(scrollback: number): void;
  // the screen once every write so far is parsed, and none after it; rejects once disposed or when serializing fails
  serialize(): Promise<ScreenSnapshot>;
  // what a serialize that failed answers with: no content, the screen's size and count
  blank(): ScreenSnapshot;
  dispose(): void;
}

export interface PtyScreenOptions {
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  // the shell's xterm option on Windows, which turns reflow off and the wrapped-line heuristics on below conpty's build 21376
  readonly windowsPty?: { readonly backend: 'conpty'; readonly buildNumber: number };
}

// Unicode 11 widths as the shell's xterm uses, so both buffers hold the same lines. OSC 633 indexes must count as main's
// Osc633Stream counts; main alone decides which sequences are trusted.
export function createPtyScreen(options: PtyScreenOptions): PtyScreen {
  const xterm = new Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollback,
    allowProposedApi: true,
    ...(options.windowsPty ? { windowsPty: { ...options.windowsPty } } : {}),
  });
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  const serializer = new SerializeAddon();
  xterm.loadAddon(serializer);
  let sequences = 0;
  let marks: Array<{ readonly index: number; readonly marker: IMarker }> = [];
  // false leaves the sequence to xterm's default, which ignores it
  xterm.parser.registerOscHandler(633, (data) => {
    const index = sequences++;
    // A mark lives in the normal buffer, as the shell's command model keeps it.
    const marker = xterm.buffer.active.type === 'normal' && MARKED_SEQUENCE.test(data) ? xterm.registerMarker(0) : undefined;
    if (marker) {
      marks.push({ index, marker });
      for (const evicted of marks.splice(0, marks.length - MAX_TERMINAL_SCREEN_MARKS)) evicted.marker.dispose();
    }
    return false;
  });

  const blank = (): ScreenSnapshot => ({ data: '', cols: xterm.cols, rows: xterm.rows, marks: [], sequences });

  // Runs inside a write callback: xterm parses the next queued chunk right after it returns. The scrollback is cut to what
  // fits MAX_TERMINAL_SCREEN_CHARS at the longest a cell serializes, so no string past it is built.
  const snapshot = (): ScreenSnapshot => {
    marks = marks.filter((mark) => !mark.marker.isDisposed);
    const { cols, rows } = xterm;
    const screens = xterm.buffer.active.type === 'alternate' ? 2 : 1;
    const fits = Math.floor(MAX_TERMINAL_SCREEN_CHARS / ((cols + 1) * MAX_SERIALIZED_CELL_CHARS)) - screens * rows;
    const scrollback = Math.max(0, Math.min(xterm.options.scrollback ?? 0, fits));
    const data = serializer.serialize({ scrollback });
    if (data.length > MAX_TERMINAL_SCREEN_CHARS) return blank();
    // the restored buffer starts at the first row serialized, so a mark's line moves up by the rows left out
    const first = Math.max(0, xterm.buffer.normal.length - scrollback - rows);
    const kept = marks.filter(({ marker }) => marker.line >= first).map(({ index, marker }) => ({ index, line: marker.line - first }));
    return { data, cols, rows, marks: kept, sequences };
  };

  // a disposed xterm never calls a write's callback
  const waiting = new Set<(err: unknown) => void>();
  return {
    write: (data, parsed) => xterm.write(data, parsed),
    resize: (cols, rows) => xterm.resize(cols, rows),
    clear: () => xterm.write('', () => xterm.clear()),
    setScrollback: (scrollback) => {
      xterm.options.scrollback = scrollback;
    },
    serialize: () => new Promise((resolve, reject) => {
      waiting.add(reject);
      xterm.write('', () => {
        waiting.delete(reject);
        // a throw would escape into xterm's write loop and end the process
        try {
          resolve(snapshot());
        } catch (err) {
          reject(err);
        }
      });
    }),
    blank,
    dispose: () => {
      for (const reject of waiting) reject(new Error('the screen was disposed'));
      waiting.clear();
      xterm.dispose();
    },
  };
}
