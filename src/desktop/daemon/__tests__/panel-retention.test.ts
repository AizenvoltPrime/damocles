import { describe, expect, it, vi } from 'vitest';
import { createPanelRetention } from '../panel-retention';
import { createRunRegistry } from '../run-registry';
import type { ChatActivity } from '../../../core/pi-session/session-state';

const idle = { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } as const;
const running = { ...idle, state: 'running' } as const;

// Panel view-1 is core's PanelManager panel-1; a client views it until it detaches.
function setUp() {
  const registry = createRunRegistry();
  const disposed: Array<[string, string]> = [];
  const viewed = new Set<string>();
  const retention = createPanelRetention({
    registry,
    panelIdOf: (viewId) => (viewId === 'view-1' ? 'panel-1' : undefined),
    viewed: (viewId) => viewed.has(viewId),
    dispose: (viewId, reason) => disposed.push([viewId, reason]),
    log: vi.fn(),
  });
  const activity = (value: ChatActivity): void =>
    registry.panelActivity({ panelId: 'panel-1', projectKey: '/srv/app', title: 'S1' }, value);
  return { registry, retention, disposed, viewed, activity };
}

describe('panel rule', () => {
  it('a quit or disconnect with a running turn keeps the panel, which is disposed once the turn settles with no view', () => {
    const { registry, retention, disposed, activity } = setUp();
    activity(running);
    retention.disposed('view-1', 'detach');
    expect(disposed).toEqual([]);
    registry.panelSettled('panel-1');
    expect(disposed).toEqual([['view-1', 'detach']]);
  });

  it('a pending prompt or background agents keep it as a running turn does', () => {
    const { retention, disposed, registry } = setUp();
    registry.panelActivity({ panelId: 'panel-1', projectKey: '', title: '' }, { state: 'requires_action', pendingKinds: ['question'], pendingPrompts: [{ id: 'q', kind: 'question', owner: { kind: 'main' } }], background: false });
    retention.disposed('view-1', 'detach');
    registry.panelActivity({ panelId: 'panel-1', projectKey: '', title: '' }, { ...idle, background: true });
    expect(disposed).toEqual([]);
    registry.panelActivity({ panelId: 'panel-1', projectKey: '', title: '' }, idle);
    expect(disposed).toEqual([['view-1', 'detach']]);
  });

  it('an idle panel with no view is disposed at once, to be restored from its session file', () => {
    const { retention, disposed } = setUp();
    retention.disposed('view-1', 'detach');
    expect(disposed).toEqual([['view-1', 'detach']]);
  });

  it('a user close disposes at once, a run or not', () => {
    const { retention, disposed, activity } = setUp();
    activity(running);
    retention.disposed('view-1', 'user');
    expect(disposed).toEqual([['view-1', 'user']]);
  });

  it('a kept panel a view joined again is no longer the rule\'s to dispose', () => {
    const { registry, retention, disposed, viewed, activity } = setUp();
    activity(running);
    retention.disposed('view-1', 'detach');
    viewed.add('view-1');
    registry.panelSettled('panel-1');
    expect(disposed).toEqual([]);
    // the rule let go of it: a later run ending without a view is the view's detach to report
    viewed.delete('view-1');
    activity(running);
    registry.panelSettled('panel-1');
    expect(disposed).toEqual([]);
  });

  it('chats.unload: a run keeps the panel', () => {
    const { retention, activity } = setUp();
    expect(retention.mayUnload('view-1')).toBe(true);
    activity(running);
    expect(retention.mayUnload('view-1')).toBe(false);
  });
});
