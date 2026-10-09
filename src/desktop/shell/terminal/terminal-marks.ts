// Adapted from VS Code's decorationAddon.ts and markNavigationAddon.ts (MIT, see THIRD-PARTY-NOTICES.md).
import { h, render } from 'vue';
import type { IBuffer, IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { remPx } from '@/composables/useRemPx';
import type { TerminalShellEvent } from '../../preload/terminal-channels';
import {
  commandStatus,
  createCommandModel,
  marksPartialCommand,
  navigate,
  navigationMarker,
  outputRows,
  targetScrollLine,
  type NavigationPosition,
  type TerminalCommand,
} from './terminal-commands';
import TerminalMark from './TerminalMark.vue';

export type XtermCommand = TerminalCommand<IMarker>;

// rem of the gutter the marks sit in, the xterm's left padding while marks show; the shell's style.css pads by the same.
export const MARK_GUTTER_REM = 1.25;
// How long the navigation highlight stays; the d-flash keyframe runs this long.
const HIGHLIGHT_MS = 900;

export interface TerminalMarksDeps {
  // the terminal's shell integration has reported a trusted sequence (main's TerminalInfo.integrated)
  integrated(): boolean;
  decorationsEnabled(): boolean;
  // a mark's accessible name and the label the navigation announcement reads
  label(command: XtermCommand): string;
  // the mark was clicked: its element anchors the command's menu
  activate(command: XtermCommand, element: HTMLElement): void;
  // the pointer entered (element) or left (null) a mark
  hover(command: XtermCommand, element: HTMLElement | null): void;
}

interface Mark {
  command: XtermCommand;
  readonly decoration: IDecoration;
  element: HTMLElement | null;
}

/** Plain text of buffer rows start..end (inclusive), a wrapped row joined to the row it continues. */
export function readRows(buffer: IBuffer, start: number, end: number): string {
  let text = '';
  for (let y = Math.max(0, start); y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y > start && !line.isWrapped) text += '\n';
    text += line.translateToString(true);
  }
  return text.replace(/\n+$/, '');
}

/**
 * The command marks of one xterm (VS Code's decorationAddon and markNavigationAddon): the command model fed by main's
 * shell events, a gutter mark per command, Ctrl+Up and Ctrl+Down navigation with a brief highlight, and the text of a
 * command and its output. A terminal without integration navigates the Enter marks of VS Code's partial command detection
 * instead, which draw no mark.
 */
export function createTerminalMarks(xterm: Terminal, deps: TerminalMarksDeps) {
  const model = createCommandModel<IMarker>(() => xterm.registerMarker(0));
  const marks = new Map<number, Mark>();
  let partial: IMarker[] = [];
  let position: NavigationPosition<IMarker> = { kind: 'bottom' };
  let highlight: { decoration: IDecoration; timer: ReturnType<typeof setTimeout> } | null = null;
  const subscriptions: IDisposable[] = [];

  function paint(mark: Mark): void {
    const element = mark.element;
    if (!element) return;
    render(h(TerminalMark, {
      status: commandStatus(mark.command),
      label: deps.label(mark.command),
      onActivate: (target: HTMLElement) => deps.activate(mark.command, target),
      onHover: (target: HTMLElement | null) => deps.hover(mark.command, target),
    }), element);
  }

  // xterm writes the cell's size inline on every render, so the gutter's size is written after it each time.
  function placeMark(element: HTMLElement): void {
    const gutter = remPx(MARK_GUTTER_REM);
    element.style.width = `${gutter}px`;
    element.style.marginLeft = `${-gutter}px`;
  }

  function decorate(command: XtermCommand): void {
    if (!deps.decorationsEnabled() || marks.has(command.id)) return;
    const decoration = xterm.registerDecoration({ marker: command.commandMarker, layer: 'top' });
    if (!decoration) return;
    const mark: Mark = { command, decoration, element: null };
    marks.set(command.id, mark);
    decoration.onRender((element) => {
      placeMark(element);
      if (mark.element === element) return;
      mark.element = element;
      element.classList.add('terminal-mark-decoration');
      paint(mark);
    });
    decoration.onDispose(() => {
      if (mark.element) render(null, mark.element);
      if (marks.get(command.id) === mark) marks.delete(command.id);
    });
  }

  function handle(event: TerminalShellEvent): void {
    const change = model.handle(event);
    if (!change) return;
    if (change.kind === 'started') {
      decorate(change.command);
      return;
    }
    const mark = marks.get(change.command.id);
    if (!mark) return;
    mark.command = change.command;
    paint(mark);
  }

  function markers(): IMarker[] {
    if (deps.integrated()) return model.commands().map(navigationMarker);
    partial = partial.filter((marker) => !marker.isDisposed);
    return partial;
  }

  function clearHighlight(): void {
    if (!highlight) return;
    clearTimeout(highlight.timer);
    highlight.decoration.dispose();
    highlight = null;
  }

  // The rows a navigation target spans: a command's prompt and input, else the one marked row.
  function highlightRows(marker: IMarker, command: XtermCommand | undefined): void {
    clearHighlight();
    const rows = command ? Math.max(1, command.executedMarker.line - marker.line) : 1;
    const decoration = xterm.registerDecoration({ marker, width: xterm.cols, height: Math.min(rows, xterm.rows), layer: 'bottom' });
    if (!decoration) return;
    decoration.onRender((element) => {
      const gutter = remPx(MARK_GUTTER_REM);
      element.style.marginLeft = `${-gutter}px`;
      element.style.width = `calc(100% + ${gutter}px)`;
      element.classList.add('terminal-nav-highlight');
    });
    highlight = { decoration, timer: setTimeout(clearHighlight, HIGHLIGHT_MS) };
  }

  /** Ctrl+Up (`previous`) or Ctrl+Down: scrolls to the next mark that way and returns its command, if it is one. */
  function scroll(direction: 'previous' | 'next'): XtermCommand | undefined {
    const buffer = xterm.buffer.active;
    position = navigate(direction, markers(), position, { viewportY: buffer.viewportY, baseY: buffer.baseY, rows: xterm.rows });
    if (position.kind !== 'mark') {
      clearHighlight();
      if (position.kind === 'top') xterm.scrollToTop();
      else xterm.scrollToBottom();
      return undefined;
    }
    const marker = position.marker;
    if (marker.line < buffer.viewportY || marker.line >= buffer.viewportY + xterm.rows) xterm.scrollToLine(targetScrollLine(marker.line, xterm.rows));
    const command = deps.integrated() ? model.commands().find((candidate) => navigationMarker(candidate) === marker) : undefined;
    highlightRows(marker, command);
    return command;
  }

  /** The command navigation stands on, which the keyboard's context menu offers actions for. */
  function current(): XtermCommand | undefined {
    if (position.kind !== 'mark' || !deps.integrated()) return undefined;
    const marker = position.marker;
    return model.commands().find((command) => navigationMarker(command) === marker);
  }

  /** The command's output as the buffer holds it now; null while it runs or once its rows left the buffer. */
  function outputText(command: XtermCommand): string | null {
    const rows = outputRows(command);
    return rows ? readRows(xterm.buffer.active, rows.start, rows.end) : null;
  }

  function setDecorationsEnabled(enabled: boolean): void {
    if (enabled) for (const command of model.commands()) decorate(command);
    else for (const mark of [...marks.values()]) mark.decoration.dispose();
  }

  // Typing returns navigation to the bottom; an Enter without integration marks a command (VS Code's partial detection).
  subscriptions.push(xterm.onData((data) => {
    position = { kind: 'bottom' };
    if (deps.integrated() || !marksPartialCommand(data, xterm.buffer.active.cursorX)) return;
    const marker = xterm.registerMarker(0);
    if (marker) partial.push(marker);
  }));
  // A clear screen (ED 2 or 3) drops the partial marks in the viewport; xterm still handles the sequence.
  subscriptions.push(xterm.parser.registerCsiHandler({ final: 'J' }, (params) => {
    const mode = params[0];
    if (mode === 2 || mode === 3) {
      const baseY = xterm.buffer.active.baseY;
      for (const marker of partial) if (marker.line >= baseY) marker.dispose();
      partial = partial.filter((marker) => !marker.isDisposed);
    }
    return false;
  }));

  return {
    handle,
    scroll,
    current,
    outputText,
    setDecorationsEnabled,
    commands: () => model.commands(),
    byId: (id: number) => model.byId(id),
    lastFinished: () => model.lastFinished(),
    /** The menu's Clear: xterm.clear keeps the prompt's row but disposes every marker (VS Code's clearBuffer). */
    clear(): void {
      clearHighlight();
      xterm.clear();
      model.cleared();
      partial = [];
      position = { kind: 'bottom' };
    },
    /** After xterm.reset (a restart): every marker is gone, and so is every command. */
    reset(): void {
      clearHighlight();
      for (const mark of [...marks.values()]) mark.decoration.dispose();
      model.clear();
      partial = [];
      position = { kind: 'bottom' };
    },
    dispose(): void {
      clearHighlight();
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      for (const mark of [...marks.values()]) mark.decoration.dispose();
    },
  };
}

export type TerminalMarks = ReturnType<typeof createTerminalMarks>;
