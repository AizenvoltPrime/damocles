import { describe, expect, it } from 'vitest';
import type { TerminalShellEvent } from '../../preload/terminal-channels';
import {
  MAX_TRACKED_COMMANDS,
  commandStatus,
  createCommandModel,
  durationParts,
  marksPartialCommand,
  navigate,
  navigationMarker,
  outputRows,
  targetScrollLine,
  type CommandMarker,
} from '../terminal/terminal-commands';
import { commandMenuItems, terminalMenuAction, terminalMenuItems } from '../terminal/terminal-menu';
import { terminalKeyAction } from '../terminal/terminal-keys';

interface FakeMarker extends CommandMarker {
  line: number;
  isDisposed: boolean;
  dispose(): void;
}

// A cursor that the test moves, and the markers the model registered at it.
function harness() {
  const cursor = { line: 0 };
  const markers: FakeMarker[] = [];
  const model = createCommandModel<FakeMarker>(() => {
    const marker: FakeMarker = { line: cursor.line, isDisposed: false, dispose: () => { marker.isDisposed = true; } };
    markers.push(marker);
    return marker;
  });
  return { cursor, markers, model };
}

const executed = (commandId: number, commandLine: string, time = 1000): TerminalShellEvent => ({ kind: 'commandExecuted', commandId, commandLine, time });
const finished = (commandId: number | null, exitCode: number | null, time = 2500): TerminalShellEvent => ({ kind: 'commandFinished', commandId, exitCode, time });

describe('command model', () => {
  it('builds a command from the prompt, input, execution and finish events, each marked where the cursor stood', () => {
    const { cursor, model } = harness();
    model.handle({ kind: 'promptStart' });
    model.handle({ kind: 'commandStart' });
    cursor.line = 1;
    const started = model.handle(executed(7, 'npm test'));
    expect(started?.kind).toBe('started');
    expect(commandStatus(started!.command)).toBe('running');
    cursor.line = 5;
    const done = model.handle(finished(7, 1));
    expect(done?.kind).toBe('finished');
    const command = done!.command;
    expect(command).toMatchObject({ id: 7, commandLine: 'npm test', startTime: 1000, endTime: 2500, exitCode: 1 });
    expect([command.promptMarker?.line, command.commandMarker.line, command.executedMarker.line, command.endMarker?.line]).toEqual([0, 0, 1, 5]);
    expect(commandStatus(command)).toBe('failure');
    expect(outputRows(command)).toEqual({ start: 1, end: 4 });
    expect(model.lastFinished()?.id).toBe(7);
  });

  it('draws no mark for a finish without a command, and none for an unknown or already finished id', () => {
    const { model } = harness();
    expect(model.handle(finished(null, 0))).toBeNull();
    model.handle(executed(1, 'ls'));
    expect(model.handle(finished(2, 0))).toBeNull();
    expect(model.handle(finished(1, 0))?.kind).toBe('finished');
    expect(model.handle(finished(1, 3))).toBeNull();
    expect(commandStatus(model.byId(1)!)).toBe('success');
  });

  it('treats a missing exit code as success and marks nothing where the alternate buffer gives no marker', () => {
    const model = createCommandModel<FakeMarker>(() => undefined);
    expect(model.handle(executed(1, 'vim'))).toBeNull();
    expect(commandStatus({ endMarker: { line: 1, isDisposed: false }, exitCode: null })).toBe('success');
  });

  it('tracks no command main reported no command line for, so nothing reads one back from the screen', () => {
    const { cursor, markers, model } = harness();
    model.handle({ kind: 'promptStart' });
    model.handle({ kind: 'commandStart' });
    cursor.line = 1;
    expect(model.handle(executed(4, ''))).toBeNull();
    expect(model.handle(executed(5, '  '))).toBeNull();
    expect(model.handle(finished(4, 0))).toBeNull();
    expect(model.commands()).toEqual([]);
    expect(model.lastFinished()).toBeUndefined();
    // The next command does not inherit the empty one's prompt.
    cursor.line = 3;
    expect(model.handle(executed(6, 'ls'))!.command.promptMarker).toBeNull();
    expect(markers.map((marker) => marker.line)).toEqual([0, 0, 3]);
  });

  it('forgets commands whose rows left the buffer and keeps at most the tracked count', () => {
    const { model } = harness();
    for (let id = 1; id <= MAX_TRACKED_COMMANDS + 5; id++) model.handle(executed(id, `c${id}`));
    expect(model.commands()).toHaveLength(MAX_TRACKED_COMMANDS);
    expect(model.commands()[0]!.id).toBe(6);
    (model.commands()[0]!.commandMarker as FakeMarker).isDisposed = true;
    expect(model.commands()[0]!.id).toBe(7);
  });

  // xterm.clear disposes every marker and keeps the cursor's row at the top (VS Code's clearBuffer marks it again).
  it('marks a prompt still pending again after a clear, and marks nothing while a command runs', () => {
    const { cursor, markers, model } = harness();
    cursor.line = 40;
    model.handle({ kind: 'promptStart' });
    model.handle({ kind: 'commandStart' });
    for (const marker of markers) marker.dispose();
    cursor.line = 0;
    model.cleared();
    const command = model.handle(executed(1, 'ls'))!.command;
    expect([command.promptMarker?.isDisposed, command.commandMarker.isDisposed, command.promptMarker?.line, command.commandMarker.line]).toEqual([false, false, 0, 0]);
    expect(model.commands().map((tracked) => tracked.id)).toEqual([1]);
    const before = markers.length;
    model.cleared();
    expect(markers).toHaveLength(before);
  });

  it('disposes each marker it replaces or drops, so xterm stops tracking its line', () => {
    const { cursor, markers, model } = harness();
    model.handle({ kind: 'promptStart' });
    model.handle({ kind: 'commandStart' });
    const [firstPrompt, firstInput] = markers;
    model.handle({ kind: 'promptStart' });
    expect([firstPrompt!.isDisposed, firstInput!.isDisposed]).toEqual([true, true]);
    model.handle({ kind: 'commandStart' });
    const input = markers.at(-1)!;
    model.handle({ kind: 'commandStart' });
    expect(input.isDisposed).toBe(true);
    // an empty Enter or Ctrl+C runs no command
    const [prompt, pendingInput] = [markers.at(-3)!, markers.at(-1)!];
    model.handle(executed(1, ''));
    expect([prompt.isDisposed, pendingInput.isDisposed]).toEqual([true, true]);
    for (let id = 2; id <= MAX_TRACKED_COMMANDS + 2; id++) {
      cursor.line = id;
      model.handle({ kind: 'promptStart' });
      model.handle(executed(id, `c${id}`));
      model.handle(finished(id, 0));
    }
    const evicted = markers.filter((marker) => marker.line === 2);
    expect(evicted).toHaveLength(3);
    expect(evicted.every((marker) => marker.isDisposed)).toBe(true);
    // a command whose line left the buffer gives up its other markers too
    const oldest = model.commands()[0]!;
    oldest.commandMarker.dispose();
    model.commands();
    expect([oldest.promptMarker?.isDisposed, oldest.endMarker?.isDisposed]).toEqual([true, true]);
  });

  it('navigates to a command by its prompt, else the line it was typed on', () => {
    const { cursor, model } = harness();
    cursor.line = 3;
    const command = model.handle(executed(1, 'ls'))!.command;
    expect(navigationMarker(command)).toBe(command.commandMarker);
    cursor.line = 6;
    model.handle({ kind: 'promptStart' });
    cursor.line = 7;
    const second = model.handle(executed(2, 'pwd'))!.command;
    expect(navigationMarker(second).line).toBe(6);
  });
});

describe('command navigation (VS Code\'s markNavigationAddon)', () => {
  const marks = [10, 40, 90].map((line) => ({ line, isDisposed: false }));
  const view = (viewportY: number, baseY = 100, rows = 20) => ({ viewportY, baseY, rows });

  it('steps up from the bottom through each mark to the top, and back down to the bottom', () => {
    let position = navigate('previous', marks, { kind: 'bottom' }, view(100));
    expect(position).toEqual({ kind: 'mark', marker: marks[2] });
    position = navigate('previous', marks, position, view(85));
    expect(position).toEqual({ kind: 'mark', marker: marks[1] });
    position = navigate('previous', marks, position, view(35));
    expect(position).toEqual({ kind: 'mark', marker: marks[0] });
    expect(navigate('previous', marks, position, view(5))).toEqual({ kind: 'top' });
    expect(navigate('next', marks, { kind: 'top' }, view(0))).toEqual({ kind: 'mark', marker: marks[0] });
    expect(navigate('next', marks, { kind: 'mark', marker: marks[2]! }, view(85))).toEqual({ kind: 'bottom' });
  });

  it('starts from the viewport once the reader scrolled away from the current position', () => {
    expect(navigate('previous', marks, { kind: 'bottom' }, view(50))).toEqual({ kind: 'mark', marker: marks[1] });
    expect(navigate('next', marks, { kind: 'mark', marker: marks[0]! }, view(50))).toEqual({ kind: 'mark', marker: marks[2] });
  });

  it('goes to the top or bottom when there is no mark', () => {
    expect(navigate('previous', [], { kind: 'bottom' }, view(100))).toEqual({ kind: 'top' });
    expect(navigate('next', [], { kind: 'top' }, view(0))).toEqual({ kind: 'bottom' });
  });

  it('shows a mark a quarter down the viewport', () => {
    expect(targetScrollLine(40, 20)).toBe(35);
    expect(targetScrollLine(2, 20)).toBe(0);
  });

  it('marks an Enter typed after a prompt in a terminal without integration (VS Code\'s partial detection)', () => {
    expect(marksPartialCommand('\r', 2)).toBe(true);
    expect(marksPartialCommand('\r', 1)).toBe(false);
    expect(marksPartialCommand('a', 10)).toBe(false);
  });
});

describe('command keys and menus', () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent => ({ code, key: code, type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

  it('always takes Ctrl+Up and Ctrl+Down (Cmd on macOS) for navigation, as VS Code\'s skip list does', () => {
    expect(terminalKeyAction(key('ArrowUp', { ctrlKey: true }), 'win32', false, [])).toBe('previousCommand');
    expect(terminalKeyAction(key('ArrowDown', { ctrlKey: true }), 'linux', false, [])).toBe('nextCommand');
    expect(terminalKeyAction(key('ArrowUp', { metaKey: true }), 'darwin', false, [])).toBe('previousCommand');
    expect(terminalKeyAction(key('ArrowUp', { ctrlKey: true }), 'darwin', false, [])).toBeUndefined();
    expect(terminalKeyAction(key('ArrowUp', { ctrlKey: true, shiftKey: true }), 'win32', false, [])).toBeUndefined();
    expect(terminalKeyAction(key('ArrowUp'), 'win32', false, [])).toBeUndefined();
  });

  it('offers the mark menu\'s four actions, each disabled without what it needs', () => {
    const t = (id: string): string => id;
    const ids = (items: ReturnType<typeof commandMenuItems>) => items.map((item) => (item.kind === 'item' ? `${item.id}${item.disabled ? ':off' : ''}` : '-'));
    expect(ids(commandMenuItems({ hasCommandLine: true, hasOutput: true }, t))).toEqual(['rerunCommand', '-', 'copyCommand', 'copyOutput', '-', 'addOutputToChat']);
    expect(ids(commandMenuItems({ hasCommandLine: false, hasOutput: false }, t))).toEqual(['rerunCommand:off', '-', 'copyCommand:off', 'copyOutput:off', '-', 'addOutputToChat:off']);
    expect(terminalMenuAction('addOutputToChat')).toBe('addOutputToChat');
  });

  it('adds the last command\'s copies and Add to Chat to the terminal menu, and leads with a navigated command', () => {
    const t = (id: string): string => id;
    const ids = (items: ReturnType<typeof terminalMenuItems>) => items.map((item) => (item.kind === 'item' ? `${item.id}${item.disabled ? ':off' : ''}` : '-'));
    expect(ids(terminalMenuItems({ target: 'terminal', hasSelection: false, platform: 'win32', group: { panes: 1, shortcut: 'Ctrl+Shift+5' } }, t))).toEqual([
      'copy:off', 'paste', 'selectAll', 'clear', '-', 'copyLastCommand:off', 'copyLastCommandOutput:off', 'addToChat:off', '-', 'split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill',
    ]);
    const withCommand = terminalMenuItems({ target: 'terminal', hasSelection: true, platform: 'win32', group: { panes: 1, shortcut: 'Ctrl+Shift+5' }, lastCommand: { hasCommandLine: true, hasOutput: false }, navigated: { hasCommandLine: true, hasOutput: true } }, t);
    expect(ids(withCommand).slice(0, 7)).toEqual(['rerunCommand', '-', 'copyCommand', 'copyOutput', '-', 'addOutputToChat', '-']);
    expect(ids(withCommand)).toContain('copyLastCommandOutput:off');
    expect(ids(withCommand)).toContain('addToChat');
    expect(ids(terminalMenuItems({ target: 'tab', hasSelection: true, platform: 'win32', group: { panes: 1, shortcut: 'Ctrl+Shift+5' }, navigated: { hasCommandLine: true, hasOutput: true } }, t))).toEqual(['split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
  });

  it('reads a duration in milliseconds under a second, tenths under ten seconds, whole seconds under a minute, then minutes', () => {
    expect(durationParts(40)).toEqual({ unit: 'milliseconds', milliseconds: 40 });
    expect(durationParts(-5)).toEqual({ unit: 'milliseconds', milliseconds: 0 });
    expect(durationParts(1299)).toEqual({ unit: 'seconds', seconds: 1.2, fractionDigits: 1 });
    expect(durationParts(42_600)).toEqual({ unit: 'seconds', seconds: 42, fractionDigits: 0 });
    expect(durationParts(125_000)).toEqual({ unit: 'minutes', minutes: 2, seconds: 5 });
  });
});
