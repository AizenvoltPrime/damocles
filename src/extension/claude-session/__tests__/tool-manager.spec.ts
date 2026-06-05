import { describe, it, expect } from 'vitest';
import { ToolManager } from '../tool-manager';
import type { MessageCallbacks } from '../types';
import type { PermissionHandler } from '../../permission-handler';

function makeToolManager(): ToolManager {
  const callbacks: MessageCallbacks = { onMessage: () => {} };
  return new ToolManager(null as unknown as PermissionHandler, callbacks, '/tmp');
}

describe('ToolManager background task tracking', () => {
  it('keeps a registered background task across resetTurn', () => {
    const tm = makeToolManager();
    tm.registerBackgroundTask('task-1');
    expect(tm.isBackgroundTask('task-1')).toBe(true);
    tm.resetTurn();
    expect(tm.isBackgroundTask('task-1')).toBe(true);
  });

  it('drops a background task only when explicitly unregistered', () => {
    const tm = makeToolManager();
    tm.registerBackgroundTask('task-1');
    tm.resetTurn();
    tm.unregisterBackgroundTask('task-1');
    expect(tm.isBackgroundTask('task-1')).toBe(false);
  });
});

describe('ToolManager background tool-use detection', () => {
  it('flags a tool invoked with run_in_background', () => {
    const tm = makeToolManager();
    tm.handlePreToolUse('Bash', 'tool-bg', { command: 'sleep 5', run_in_background: true });
    expect(tm.isBackgroundToolUse('tool-bg')).toBe(true);
  });

  it('does not flag a foreground tool', () => {
    const tm = makeToolManager();
    tm.handlePreToolUse('Bash', 'tool-fg', { command: 'ls' });
    expect(tm.isBackgroundToolUse('tool-fg')).toBe(false);
  });

  it('clears background tool-use flags on resetTurn (detection is same-turn only)', () => {
    const tm = makeToolManager();
    tm.handlePreToolUse('Bash', 'tool-bg', { command: 'sleep 5', run_in_background: true });
    tm.resetTurn();
    expect(tm.isBackgroundToolUse('tool-bg')).toBe(false);
  });
});
