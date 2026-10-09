// Adapted from VS Code's commandDetection capability, markNavigationAddon.ts and partialCommandDetectionCapability.ts (MIT, see THIRD-PARTY-NOTICES.md).
import type { TerminalShellEvent } from '../../preload/terminal-channels';

// The parts of an xterm marker the command model reads; xterm's IMarker has them.
export interface CommandMarker {
  readonly line: number;
  readonly isDisposed: boolean;
}

// A marker the command model owns; xterm keeps each one's buffer listeners until it is disposed.
export interface OwnedMarker extends CommandMarker {
  dispose(): void;
}

export interface TerminalCommand<M extends CommandMarker = CommandMarker> {
  // main's commandId, unique within the terminal
  readonly id: number;
  readonly commandLine: string;
  // where the prompt started (A), when the shell reported one
  readonly promptMarker: M | null;
  // the line the command was typed on (B, else where it was executed)
  readonly commandMarker: M;
  // where the output starts (C)
  readonly executedMarker: M;
  // where the next prompt took over (D); null while the command runs
  readonly endMarker: M | null;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly exitCode: number | null;
}

export type CommandStatus = 'running' | 'success' | 'failure';

export function commandStatus(command: Pick<TerminalCommand, 'endMarker' | 'exitCode'>): CommandStatus {
  if (command.endMarker === null) return 'running';
  return command.exitCode === null || command.exitCode === 0 ? 'success' : 'failure';
}

export type CommandChange<M extends CommandMarker> =
  | { readonly kind: 'started'; readonly command: TerminalCommand<M> }
  | { readonly kind: 'finished'; readonly command: TerminalCommand<M> };

// Commands one terminal keeps for its marks and menus; main tracks as many labels.
export const MAX_TRACKED_COMMANDS = 100;

/**
 * One terminal's commands from main's shell events (VS Code's command detection, capabilities/commandDetection), which
 * the view applies in stream order once xterm has parsed the output before each event. `mark` registers a marker at the
 * cursor line (undefined in the alternate buffer, where an event marks nothing). A command main reports no command line for
 * (an empty Enter, a cancelled line) is no command, as in VS Code: it gets no mark and is never the last command, and its
 * text is never read back from rows that program output can rewrite.
 */
export function createCommandModel<M extends OwnedMarker>(mark: () => M | undefined) {
  let commands: TerminalCommand<M>[] = [];
  let prompt: M | null = null;
  let input: M | null = null;

  // Disposing twice is harmless, and a command's input and executed markers may be one.
  const drop = (...markers: ReadonlyArray<M | null>): void => {
    for (const marker of markers) marker?.dispose();
  };
  const dropCommand = (command: TerminalCommand<M>): void => drop(command.promptMarker, command.commandMarker, command.executedMarker, command.endMarker);

  function handle(event: TerminalShellEvent): CommandChange<M> | null {
    if (event.kind === 'promptStart') {
      drop(prompt, input);
      prompt = mark() ?? null;
      input = null;
      return null;
    }
    if (event.kind === 'commandStart') {
      drop(input);
      input = mark() ?? null;
      return null;
    }
    if (event.kind === 'commandExecuted') {
      const executed = event.commandLine.trim() === '' ? undefined : mark();
      if (!executed) {
        drop(prompt, input);
        prompt = null;
        input = null;
        return null;
      }
      const command: TerminalCommand<M> = {
        id: event.commandId,
        commandLine: event.commandLine,
        promptMarker: prompt,
        commandMarker: input ?? executed,
        executedMarker: executed,
        endMarker: null,
        startTime: event.time,
        endTime: null,
        exitCode: null,
      };
      prompt = null;
      input = null;
      commands = [...commands, command];
      for (const evicted of commands.splice(0, commands.length - MAX_TRACKED_COMMANDS)) dropCommand(evicted);
      return { kind: 'started', command };
    }
    const index = event.commandId === null ? -1 : commands.findIndex((command) => command.id === event.commandId && command.endMarker === null);
    const end = index < 0 ? undefined : mark();
    if (!end) return null;
    const finished: TerminalCommand<M> = { ...commands[index]!, endMarker: end, endTime: event.time, exitCode: event.exitCode };
    commands = commands.map((command, at) => (at === index ? finished : command));
    return { kind: 'finished', command: finished };
  }

  return {
    handle,
    /** In stream order, without those whose lines left the buffer. */
    commands(): readonly TerminalCommand<M>[] {
      for (const command of commands) if (command.commandMarker.isDisposed) dropCommand(command);
      commands = commands.filter((command) => !command.commandMarker.isDisposed);
      return commands;
    },
    byId(id: number): TerminalCommand<M> | undefined {
      return this.commands().find((command) => command.id === id);
    },
    /** The newest finished command, which Copy Last Command and its output name. */
    lastFinished(): TerminalCommand<M> | undefined {
      return this.commands().filter((command) => command.endMarker !== null).at(-1);
    },
    clear(): void {
      for (const command of commands) dropCommand(command);
      drop(prompt, input);
      commands = [];
      prompt = null;
      input = null;
    },
    /** After xterm.clear, which disposes every marker but keeps the cursor's row: a prompt still pending is marked there again. */
    cleared(): void {
      if (prompt) prompt = mark() ?? null;
      if (input) input = mark() ?? null;
    },
  };
}

export type CommandModel<M extends OwnedMarker> = ReturnType<typeof createCommandModel<M>>;

/** The marker a command is navigated to and its mark is drawn on: its prompt, else the line it was typed on. */
export function navigationMarker<M extends CommandMarker>(command: TerminalCommand<M>): M {
  return command.promptMarker && !command.promptMarker.isDisposed ? command.promptMarker : command.commandMarker;
}

/** The buffer rows a command's output spans: from where it was executed up to the row before the next prompt took over. */
export function outputRows(command: Pick<TerminalCommand, 'executedMarker' | 'endMarker'>): { start: number; end: number } | null {
  if (command.endMarker === null || command.executedMarker.isDisposed || command.endMarker.isDisposed) return null;
  return { start: command.executedMarker.line, end: command.endMarker.line - 1 };
}

// Where navigation stands (VS Code's MarkNavigationAddon): above the first mark, below the last, or on a mark.
export type NavigationPosition<M> = { readonly kind: 'top' } | { readonly kind: 'bottom' } | { readonly kind: 'mark'; readonly marker: M };

export interface NavigationViewport {
  readonly viewportY: number;
  readonly baseY: number;
  readonly rows: number;
}

/** The line to scroll to so a mark shows a quarter down the viewport: the context below matters more than above. */
export function targetScrollLine(line: number, rows: number): number {
  return Math.max(line - Math.floor(rows / 4), 0);
}

const inViewport = (line: number, view: NavigationViewport): boolean => line >= view.viewportY && line < view.viewportY + view.rows;

/**
 * Where Ctrl+Up (`previous`) or Ctrl+Down moves to, VS Code's scrollToPreviousMark and scrollToNextMark: once the reader
 * has scrolled away from the current position, the step starts from the viewport instead; past either end it goes to the
 * top or bottom of the buffer.
 */
export function navigate<M extends CommandMarker>(
  direction: 'previous' | 'next',
  markers: readonly M[],
  position: NavigationPosition<M>,
  view: NavigationViewport,
): NavigationPosition<M> {
  const scrolled = position.kind === 'mark'
    ? !inViewport(position.marker.line, view)
    : (position.kind === 'bottom' ? view.baseY : 0) !== view.viewportY;
  let index: number;
  if (direction === 'previous') {
    if (scrolled) index = markers.length - markers.filter((marker) => marker.line >= view.viewportY).length - 1;
    else if (position.kind === 'bottom') index = markers.length - 1;
    else if (position.kind === 'top') index = -1;
    else index = markers.indexOf(position.marker) - 1;
    if (index < 0) return { kind: 'top' };
  } else {
    if (scrolled) index = markers.filter((marker) => marker.line <= view.viewportY).length;
    else if (position.kind === 'bottom') index = markers.length;
    else if (position.kind === 'top') index = 0;
    else index = markers.indexOf(position.marker) + 1;
    if (index >= markers.length) return { kind: 'bottom' };
  }
  return { kind: 'mark', marker: markers[index]! };
}

// The shortest prompt a partial mark needs before the cursor (VS Code's PartialCommandDetection MinimumPromptLength).
const PARTIAL_MIN_PROMPT_COLUMNS = 2;

/** Whether an Enter typed with the cursor at `cursorX` marks a command for navigation in a terminal without integration. */
export function marksPartialCommand(data: string, cursorX: number): boolean {
  return data === '\r' && cursorX >= PARTIAL_MIN_PROMPT_COLUMNS;
}

export type DurationParts =
  | { readonly unit: 'milliseconds'; readonly milliseconds: number }
  | { readonly unit: 'seconds'; readonly seconds: number; readonly fractionDigits: 0 | 1 }
  | { readonly unit: 'minutes'; readonly minutes: number; readonly seconds: number };

/** A mark's duration in the unit its hover reads: milliseconds under a second, tenths under ten seconds, then whole units. */
export function durationParts(ms: number): DurationParts {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return { unit: 'milliseconds', milliseconds: clamped };
  if (clamped < 10_000) return { unit: 'seconds', seconds: Math.floor(clamped / 100) / 10, fractionDigits: 1 };
  if (clamped < 60_000) return { unit: 'seconds', seconds: Math.floor(clamped / 1000), fractionDigits: 0 };
  return { unit: 'minutes', minutes: Math.floor(clamped / 60_000), seconds: Math.floor((clamped % 60_000) / 1000) };
}
