import { describe, expect, it } from 'vitest';
import { createHandlerRegistry } from '../handler-registry';
import type { HandlerDependencies, ViewHandlerRegistry } from '../types';
import { VOICE_VIEW_MESSAGES } from '../../../../shared/remote-user';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';

describe("a remote chat view's messages on this computer's core", () => {
  it('each has a handler that reads only the host it replies to', () => {
    const { handlers, viewHandlers } = createHandlerRegistry({ postMessage: () => undefined, platform: createFakePlatform(), subscriptions: [] } as unknown as HandlerDependencies);
    expect(Object.keys(viewHandlers).sort()).toEqual([...VOICE_VIEW_MESSAGES].sort());
    for (const type of VOICE_VIEW_MESSAGES) expect(handlers[type], type).toBe(viewHandlers[type]);
    const handler: ViewHandlerRegistry[string] = (_message, ctx) => {
      // @ts-expect-error no chat of this core stands behind a remote chat's view
      void ctx.session;
    };
    expect(handler).toBeTypeOf('function');
  });
});
