// Core reads a notice's or a question's answer as an index into the actions it offered.
import { describe, expect, it } from 'vitest';
import { createCoreEndpoint, createLoopback, createMainEndpoint, CoreProtocolError } from '../../core-protocol';
import { MAX_ACTIONS } from '../../core-protocol/messages';
import { createAskProxy, createNotificationsProxy } from '../platform/proxied';

const quiet = (): void => undefined;
const ACTIONS = [{ message: 'Retry' }, { message: 'Show Log' }];

function channel() {
  const { main, core } = createLoopback();
  const violations: CoreProtocolError[] = [];
  return { main: createMainEndpoint(main, quiet, (error) => violations.push(error)), core: createCoreEndpoint(core, quiet, (error) => violations.push(error)), violations };
}

describe('an answer main gives core', () => {
  it('is the chosen action\'s index, and one past the actions offered answers as dismissed', async () => {
    const { main, core } = channel();
    let answer: number | undefined = 1;
    main.serve('notifications.show', () => answer);
    main.serve('dialogs.ask', () => answer);
    const notifications = createNotificationsProxy(core);
    const ask = createAskProxy(core);
    const question = { severity: 'warning' as const, message: { message: 'Delete it?' }, actions: ACTIONS };

    expect([await notifications.warn({ message: 'Failed' }, ACTIONS), await ask(question)]).toEqual([1, 1]);
    answer = ACTIONS.length;
    expect([await notifications.warn({ message: 'Failed' }, ACTIONS), await ask(question)]).toEqual([undefined, undefined]);
    answer = 0;
    expect(await notifications.info({ message: 'Saved' })).toBeUndefined();
  });

  it('past the last index any notice can offer is outside the contract, so main fails that one request instead of ending core', async () => {
    const { main, core, violations } = channel();
    main.serve('notifications.show', () => MAX_ACTIONS);
    main.serve('dialogs.ask', () => MAX_ACTIONS);
    await expect(core.request('notifications.show', { severity: 'info', message: { message: 'x' }, actions: [] })).rejects.toThrow('Core protocol violation: the answer to notifications.show');
    await expect(core.request('dialogs.ask', { severity: 'info', message: { message: 'x' }, actions: [] })).rejects.toThrow('Core protocol violation: the answer to dialogs.ask');
    expect(violations).toEqual([]);
  });

  it('a default action past the last index any question can offer is outside the contract, so core never sends it', async () => {
    const { main, core, violations } = channel();
    main.serve('dialogs.ask', () => undefined);
    await expect(core.request('dialogs.ask', { severity: 'info', message: { message: 'x' }, actions: [], defaultAction: MAX_ACTIONS })).rejects.toThrow('Core protocol violation: request dialogs.ask was not sent');
    expect(violations).toEqual([]);
  });
});
