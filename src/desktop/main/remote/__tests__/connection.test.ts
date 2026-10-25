import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TERMINAL_IDLE_DAYS } from '../../../daemon/control-messages';
import type { HostStarters } from '../../../workspace/host-starters';
import { startInProcessDaemon, TEST_FACTS, type InProcessDaemon } from '../../../daemon/__tests__/in-process-daemon';
import { connect } from '../connection';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const options = { appVersion: '0.0.0-test', clientId: 'test', deviceName: 'test', terminalIdleDays: 30, log: () => undefined };

let daemon: InProcessDaemon;

beforeEach(async () => {
  daemon = await startInProcessDaemon({ starters: NO_HOSTS });
});

afterEach(async () => {
  await daemon.shutdown();
});

describe('connect', () => {
  it('hands back the daemon\'s facts once it welcomed the client and took its attach', async () => {
    const connection = await connect({ ...options, stream: await daemon.connect() });
    expect(connection.facts).toEqual(TEST_FACTS);
    expect(await connection.control.request('listRuns', {})).toEqual({ runs: [] });
    const closed = new Promise<string>((resolve) => connection.onClose(resolve));
    connection.close('done');
    expect(await closed).toBe('done');
  });

  it('ends a connection whose attach failed, so its bridge exits and the daemon stops counting it as a client', async () => {
    const stream = await daemon.connect();
    const ended = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    await expect(connect({ ...options, stream, terminalIdleDays: MAX_TERMINAL_IDLE_DAYS + 1 })).rejects.toThrow();
    await ended;
    expect(stream.destroyed).toBe(true);
  });
});
