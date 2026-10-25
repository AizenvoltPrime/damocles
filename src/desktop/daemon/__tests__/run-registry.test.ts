import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVALID } from '../../core-protocol/schema';
import { FROZEN_CLIENT_TO_CONTROL, MAX_RUN_TITLE_CHARS } from '../control-messages';
import { createRunRegistry } from '../run-registry';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listRuns titles', () => {
  it('clamps a title to what the frozen listRuns parser accepts, so one run never fails the whole answer', () => {
    const registry = createRunRegistry();
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'x'.repeat(5000) });
    registry.panelActivity({ panelId: 'panel-1', projectKey: '', title: 'y'.repeat(5000) }, { state: 'running', pendingKinds: [], pendingPrompts: [], background: false });
    expect(registry.runs().map((run) => run.title.length)).toEqual([MAX_RUN_TITLE_CHARS, MAX_RUN_TITLE_CHARS]);
    expect(FROZEN_CLIENT_TO_CONTROL.requests.listRuns.result({ runs: registry.runs() })).not.toBe(INVALID);
  });
});

describe('run registry, terminals', () => {
  it('lists its terminals as listRuns reports them', () => {
    const registry = createRunRegistry();
    registry.addTerminal({ id: 'term-1', projectKey: '/srv/app', title: 'bash' });
    expect(registry.runs()).toEqual([{ kind: 'terminal', id: 'term-1', projectKey: '/srv/app', title: 'bash', state: 'running', providers: [] }]);
    expect(registry.isEmpty()).toBe(false);
    registry.removeTerminal('term-1');
    expect(registry.isEmpty()).toBe(true);
  });

  it('ends a terminal nobody attached for the latest client\'s terminalIdleDays', () => {
    const registry = createRunRegistry();
    const ended: string[] = [];
    registry.onIdle((id) => ended.push(id));
    registry.setIdleDays(3);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.setAttached('term-1', 1);
    vi.advanceTimersByTime(10 * DAY);
    expect(ended).toEqual([]);
    registry.setAttached('term-1', 0);
    // a later client's value applies, even while the app is closed
    registry.setIdleDays(1);
    vi.advanceTimersByTime(DAY - 1);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ended).toEqual(['term-1']);
  });

  it('never ends a terminal with terminalIdleDays 0, and restarts the clock on attach', () => {
    const registry = createRunRegistry();
    const ended: string[] = [];
    registry.onIdle((id) => ended.push(id));
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.setAttached('term-1', 0);
    registry.setIdleDays(0);
    vi.advanceTimersByTime(400 * DAY);
    expect(ended).toEqual([]);
    registry.setAttached('term-1', 1);
    registry.setAttached('term-1', 0);
    registry.setIdleDays(30);
    // past setTimeout's 24.8-day limit: the timer re-arms
    vi.advanceTimersByTime(29 * DAY);
    registry.setAttached('term-1', 1);
    registry.setAttached('term-1', 0);
    vi.advanceTimersByTime(29 * DAY);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(DAY);
    expect(ended).toEqual(['term-1']);
  });
});

describe('run registry, panels', () => {
  const idle = { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } as const;
  const running = { ...idle, state: 'running' } as const;
  const waiting = { state: 'requires_action', pendingKinds: ['approval'], pendingPrompts: [{ id: 'p1', kind: 'approval', owner: { kind: 'main' } }], background: false } as const;
  const panel = { panelId: 'panel-1', projectKey: '/srv/app', title: 'S1' };

  it('holds a panel with a running turn, a pending prompt or background agents, and lists it for listRuns', () => {
    const registry = createRunRegistry();
    const changes = vi.fn();
    registry.onChange(changes);
    registry.panelActivity(panel, running);
    expect(registry.runs()).toEqual([{ kind: 'chat', id: 'panel-1', projectKey: '/srv/app', title: 'S1', state: 'running', providers: [] }]);
    expect(registry.isEmpty()).toBe(false);
    registry.panelActivity(panel, waiting);
    expect(registry.runs()[0]?.state).toBe('waiting');
    registry.panelActivity(panel, { ...idle, background: true });
    expect(registry.runs()[0]?.state).toBe('background');
    registry.panelActivity(panel, idle);
    expect(registry.isEmpty()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('a settled turn ends the run unless a prompt or background agents still hold it', () => {
    const registry = createRunRegistry();
    registry.panelActivity(panel, running);
    registry.panelSettled('panel-1');
    expect(registry.hasPanelRun('panel-1')).toBe(false);
    registry.panelActivity(panel, { ...running, background: true });
    registry.panelSettled('panel-1');
    expect(registry.runs()[0]?.state).toBe('background');
    registry.removePanel('panel-1');
    expect(registry.isEmpty()).toBe(true);
  });

  it('an idle panel is never a run', () => {
    const registry = createRunRegistry();
    registry.panelActivity(panel, idle);
    expect(registry.isEmpty()).toBe(true);
  });
});
