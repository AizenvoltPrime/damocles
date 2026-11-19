import { describe, it, expect, vi } from 'vitest';
import { createBrowserHandlers } from '../browser-handlers';
import { PickCancelledError } from '../../../../browser/element-picker';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { WebviewToExtensionMessage } from '../../../../../shared/types/messages';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

// The chat composer's pick button: its pick goes to the chat that asked, and a cancel is not a failure.
async function pickWith(outcome: Promise<unknown>): Promise<unknown[]> {
  const posted: unknown[] = [];
  const browserService = { isConnected: () => true, pickElement: () => outcome };
  const handlers = createBrowserHandlers({ postMessage: (_host: unknown, message: unknown) => posted.push(message), browserService } as unknown as HandlerDependencies);
  await handlers.pickBrowserElement!({ type: 'pickBrowserElement' } as WebviewToExtensionMessage, { host: {}, reply: {} } as unknown as HandlerContext);
  return posted;
}

describe("the chat's pick button", () => {
  it('posts nothing when the pick is cancelled', async () => {
    expect(await pickWith(Promise.reject(new PickCancelledError()))).toEqual([]);
  });

  it('shows any other failure as an error notification', async () => {
    expect(await pickWith(Promise.reject(new Error('Element picking timed out after 60s with no selection')))).toEqual([
      { type: 'notification', message: expect.objectContaining({ message: 'Element pick failed: {0}' }), notificationType: 'error' },
    ]);
  });
});
