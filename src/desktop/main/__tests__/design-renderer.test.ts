import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, protocol: {} }));

import { MAX_CONSOLE_ERRORS } from '../../../shared/design-render';
import { channelSend, pageConsole, reportFailures } from '../design/design-renderer';

describe('the design renderer process', () => {
  it('forwards at most MAX_CONSOLE_ERRORS console errors a page, so a page logging in a loop sends main no more', () => {
    const sent: unknown[] = [];
    const first = pageConsole(1, (message) => sent.push(message));
    const second = pageConsole(2, (message) => sent.push(message));
    for (let index = 0; index < 500; index++) first(`error ${index}`);
    second('TypeError: x');
    expect(sent).toHaveLength(MAX_CONSOLE_ERRORS + 1);
    expect(sent.at(-1)).toEqual({ t: 'console', page: 2, text: 'TypeError: x' });
  });

  it('sends nothing once its channel is disconnected', () => {
    const send = vi.fn();
    channelSend({ send, connected: false })({ t: 'ready' });
    expect(send).not.toHaveBeenCalled();
    channelSend({ send, connected: true })({ t: 'ready' });
    expect(send).toHaveBeenCalledWith({ t: 'ready' });
  });

  it('logs an uncaught exception and exits instead of showing Electron\'s dialog, and logs a rejection', () => {
    const target = new EventEmitter();
    const lines: string[] = [];
    const exit = vi.fn();
    reportFailures(target as unknown as NodeJS.Process, (line) => lines.push(line), exit);
    target.emit('uncaughtException', new Error('boom'));
    expect(exit).toHaveBeenCalledWith(1);
    target.emit('unhandledRejection', new Error('late'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes('uncaught exception') && line.includes('boom'))).toBe(true);
    expect(lines.some((line) => line.includes('unhandled rejection') && line.includes('late'))).toBe(true);
  });
});
