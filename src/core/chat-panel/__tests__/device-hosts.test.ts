import { describe, expect, it } from 'vitest';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { runPin } from '../../client-snapshots';
import { deviceHost, forEachDevice } from '../device-hosts';
import type { PanelHost } from '../../../platform/window-service';

/** A panel three views show: view-1 and view-3 on device-a, view-2 on device-b. */
function threeViewPanel() {
  const toView = new Map<string, unknown[]>();
  const toPanel: unknown[] = [];
  const views = [{ viewKey: 'view-1', clientId: 'device-a' }, { viewKey: 'view-2', clientId: 'device-b' }, { viewKey: 'view-3', clientId: 'device-a' }];
  const panel = {
    postMessage: async (message: unknown) => void toPanel.push(message),
    views: () => views,
    viewHost: (viewKey: string): PanelHost => ({
      panelHost: panel,
      clientId: views.find((view) => view.viewKey === viewKey)?.clientId,
      postMessage: async (message: unknown) => void toView.set(viewKey, [...(toView.get(viewKey) ?? []), message]),
    }) as unknown as PanelHost,
  } as unknown as PanelHost;
  return { panel, toView, toPanel };
}

describe('forEachDevice', () => {
  it('sends once to the panel on a core with no clients', () => {
    const { panel } = threeViewPanel();
    const targets: PanelHost[] = [];
    forEachDevice(undefined, panel, (target) => targets.push(target));
    expect(targets).toEqual([panel]);
  });

  it('on a daemon\'s core sends once per device, built as that device\'s client and reaching only its views', () => {
    const { panel, toView, toPanel } = threeViewPanel();
    const read = forEachDevice(createFakeRemoteHost().remote, panel, (target) => {
      const clientId = runPin()?.clientId;
      void target.postMessage({ type: 'built', clientId });
      return clientId;
    });
    expect(read).toEqual(['device-a', 'device-b']);
    expect(toPanel).toEqual([]);
    expect(Object.fromEntries(toView)).toEqual({
      'view-1': [{ type: 'built', clientId: 'device-a' }],
      'view-2': [{ type: 'built', clientId: 'device-b' }],
      'view-3': [{ type: 'built', clientId: 'device-a' }],
    });
  });

  it('builds a post to one view or device as that view\'s client', () => {
    const { panel } = threeViewPanel();
    const remote = createFakeRemoteHost().remote;
    expect(forEachDevice(remote, panel.viewHost!('view-2'), () => runPin()?.clientId)).toEqual(['device-b']);
    expect(forEachDevice(remote, deviceHost(panel, 'device-a'), () => runPin()?.clientId)).toEqual(['device-a']);
  });
});
