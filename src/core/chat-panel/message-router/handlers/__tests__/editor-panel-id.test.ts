import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createBrowserHandlers } from '../browser-handlers';
import { createCompassHandlers } from '../compass-handlers';
import type { HandlerContext, HandlerDependencies } from '../../types';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

// Editor requests carry the originating panel so a host that renders editors in the chat panel shows them there.
describe('editor requests from the router name the originating panel', () => {
  const ctx = (fsPath: string) =>
    ({ host: {}, panelId: 'host-3', folder: { key: fsPath, fsPath, name: 'ws', label: 'ws', projectScope: true } }) as unknown as HandlerContext;

  it('openElementContext', async () => {
    const platform = createFakePlatform();
    const handlers = createBrowserHandlers({ platform, postMessage: () => undefined } as unknown as HandlerDependencies);

    await handlers.openElementContext!({ type: 'openElementContext', content: '<div></div>' }, ctx('/ws'));

    expect(platform.editor.untitled).toEqual([{ content: '<div></div>', language: 'html', options: { panelId: 'host-3' } }]);
  });

  it('compassNavigateToNode', async () => {
    const root = os.tmpdir();
    const platform = createFakePlatform({ folders: [{ fsPath: root, name: 'tmp' }] });
    const handlers = createCompassHandlers({ platform, postMessage: () => undefined } as unknown as HandlerDependencies);
    const file = `${root}/a.ts`;

    await handlers.compassNavigateToNode!({ type: 'compassNavigateToNode', filePath: file, line: 4 }, ctx(root));

    expect(platform.editor.openedFiles).toEqual([{ path: file, options: { editor: 'text', line: 4, panelId: 'host-3' } }]);
  });
});
