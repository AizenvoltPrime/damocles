import { describe, it, expect, vi } from 'vitest';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createWorkspaceHandlers } from '../workspace-handlers';
import type { HandlerContext, HandlerDependencies } from '../../types';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

describe('openSettings from the webview', () => {
  const open = () => {
    const platform = createFakePlatform();
    const handlers = createWorkspaceHandlers({ platform, postMessage: () => undefined } as unknown as HandlerDependencies);
    const send = (query?: unknown) => handlers.openSettings!({ type: 'openSettings', ...(query !== undefined ? { query } : {}) } as never, {} as HandlerContext);
    return { platform, send };
  };

  it('filters the host settings editor to a Damocles key the webview names', async () => {
    const { platform, send } = open();
    await send('damocles.tools.disabled');
    expect(platform.editor.settingsQueries).toEqual(['damocles.tools.disabled']);
  });

  it('filters to every Damocles setting with no query, or one that is not a Damocles key', async () => {
    const { platform, send } = open();
    for (const query of [undefined, 'workbench.colorTheme', 'damocles.x"; rm', 42, 'damocles.']) await send(query);
    expect(platform.editor.settingsQueries).toEqual(['damocles', 'damocles', 'damocles', 'damocles', 'damocles']);
  });
});
