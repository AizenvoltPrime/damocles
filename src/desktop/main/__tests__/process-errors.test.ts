import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { logUncaughtErrors } from '../process-errors';

describe('logUncaughtErrors', () => {
  it('logs an uncaught exception and an unhandled rejection with their stacks', () => {
    const target = new EventEmitter();
    const lines: string[] = [];
    logUncaughtErrors(target, (line) => lines.push(line));

    const thrown = new Error('watcher callback threw');
    target.emit('uncaughtException', thrown, 'uncaughtException');
    target.emit('unhandledRejection', 'no xdg-open', Promise.resolve());

    expect(lines).toEqual([`[main] uncaught exception: ${thrown.stack}`, '[main] unhandled rejection: no xdg-open']);
  });
});
