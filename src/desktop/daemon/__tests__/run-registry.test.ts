import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVALID } from '../../core-protocol/schema';
import { CLIENT_TO_CONTROL, FROZEN_CLIENT_TO_CONTROL, MAX_RUN_TITLE_CHARS } from '../control-messages';
import { createRunRegistry } from '../run-registry';

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
});

describe('run registry, panels', () => {
  const idle = { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } as const;
  const running = { ...idle, state: 'running' } as const;
  const waiting = { state: 'requires_action', pendingKinds: ['approval'], pendingPrompts: [{ id: 'p1', kind: 'approval', owner: { kind: 'main' } }], background: false } as const;
  const panel = { panelId: 'panel-1', projectKey: '/srv/app', title: 'S1' };

  it('reports a chat run, which a terminal is not', () => {
    const registry = createRunRegistry();
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    expect(registry.hasChatRun()).toBe(false);
    registry.panelActivity(panel, running);
    expect(registry.hasChatRun()).toBe(true);
    registry.panelActivity(panel, idle);
    expect(registry.hasChatRun()).toBe(false);
  });

  it('lists a pending CLI wait until it ends, apart from the frozen listRuns, and tells its start and end', () => {
    const registry = createRunRegistry();
    const changes = vi.fn();
    registry.onChange(changes);
    const wait = registry.cliWait('x'.repeat(5000));
    const other = registry.cliWait('COMMIT_EDITMSG');
    expect(registry.cliWaits()).toEqual(['x'.repeat(MAX_RUN_TITLE_CHARS), 'COMMIT_EDITMSG']);
    expect(registry.runs()).toEqual([]);
    expect(registry.hasChatRun()).toBe(false);
    wait.dispose();
    wait.dispose();
    expect(registry.cliWaits()).toEqual(['COMMIT_EDITMSG']);
    other.dispose();
    expect(registry.cliWaits()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(4);
  });

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

  // device A's close must never stop or keep a turn device B started on the same daemon
  it('lists for a client only the chat runs its own work started, kept through the run, and forgets the owner with it', () => {
    const registry = createRunRegistry();
    registry.panelActivity(panel, running, 'device-a');
    registry.panelActivity({ ...panel, panelId: 'panel-2' }, running, 'device-b');
    // another device answering a prompt of A's turn does not take it over
    registry.panelActivity(panel, waiting, 'device-b');
    registry.addTerminal({ id: 'term-1', projectKey: '/srv/app', title: 'bash' });
    expect(registry.ownRuns('device-a').map((run) => run.id)).toEqual(['panel-1']);
    expect(registry.ownRuns('device-b').map((run) => run.id)).toEqual(['panel-2']);
    registry.panelActivity(panel, idle);
    registry.panelActivity(panel, running, 'device-b');
    expect(registry.ownRuns('device-a')).toEqual([]);
    expect(registry.ownRuns('device-b').map((run) => run.id)).toEqual(['panel-2', 'panel-1']);
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

  // the frozen listRuns never carries configuredProviders, so its shape stays as every app reads it
  it('lists the configured providers only for listOwnRuns, from the latest report, and omits them for a panel that never reported', () => {
    const registry = createRunRegistry();
    registry.panelActivity(panel, running, 'device-a');
    registry.panelActivity({ ...panel, panelId: 'panel-2' }, running, 'device-a');
    registry.panelProviders('panel-1', ['anthropic']);
    registry.panelConfiguredProviders('panel-1', ['anthropic', 'openai-codex']);
    registry.panelConfiguredProviders('panel-1', ['github-copilot']);
    const own = registry.ownRuns('device-a');
    expect(own).toEqual([
      { kind: 'chat', id: 'panel-1', projectKey: '/srv/app', title: 'S1', state: 'running', providers: ['anthropic'], configuredProviders: ['github-copilot'] },
      { kind: 'chat', id: 'panel-2', projectKey: '/srv/app', title: 'S1', state: 'running', providers: [] },
    ]);
    expect(own[1]).not.toHaveProperty('configuredProviders');
    expect(CLIENT_TO_CONTROL.requests.listOwnRuns.result({ runs: own })).toEqual({ runs: own });
    expect(registry.runs().some((run) => 'configuredProviders' in run)).toBe(false);
    expect(FROZEN_CLIENT_TO_CONTROL.requests.listRuns.result({ runs: registry.runs() })).not.toBe(INVALID);
  });

  it('keeps the configured providers while the panel lives, and forgets them with the panel', () => {
    const registry = createRunRegistry();
    registry.panelConfiguredProviders('panel-1', ['openai-codex']);
    registry.panelActivity(panel, running, 'device-a');
    expect(registry.ownRuns('device-a')[0]?.configuredProviders).toEqual(['openai-codex']);
    registry.panelSettled('panel-1');
    registry.panelActivity(panel, running, 'device-a');
    expect(registry.ownRuns('device-a')[0]?.configuredProviders).toEqual(['openai-codex']);
    registry.removePanel('panel-1');
    registry.panelActivity(panel, running, 'device-a');
    expect(registry.ownRuns('device-a')[0]).not.toHaveProperty('configuredProviders');
  });

  it('listOwnRuns refuses configured providers past the bounds of providers', () => {
    const entry = { kind: 'chat', id: 'panel-1', projectKey: '', title: '', state: 'running', providers: [] };
    const parse = CLIENT_TO_CONTROL.requests.listOwnRuns.result;
    expect(parse({ runs: [{ ...entry, configuredProviders: Array.from({ length: 256 }, (_, i) => `p${i}`) }] })).not.toBe(INVALID);
    expect(parse({ runs: [{ ...entry, configuredProviders: Array.from({ length: 257 }, (_, i) => `p${i}`) }] })).toBe(INVALID);
    expect(parse({ runs: [{ ...entry, configuredProviders: ['x'.repeat(129)] }] })).toBe(INVALID);
    expect(parse({ runs: [{ ...entry, configuredProviders: [''] }] })).toBe(INVALID);
  });

  it('an idle panel is never a run', () => {
    const registry = createRunRegistry();
    registry.panelActivity(panel, idle);
    expect(registry.isEmpty()).toBe(true);
  });
});
