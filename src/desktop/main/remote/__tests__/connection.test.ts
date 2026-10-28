import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TERMINAL_IDLE_DAYS } from '../../../daemon/control-messages';
import type { HostStarters } from '../../../workspace/host-starters';
import { startInProcessDaemon, TEST_FACTS, type InProcessDaemon } from '../../../daemon/__tests__/in-process-daemon';
import { connect, OtherProtocolError, type OtherProtocolDaemon } from '../connection';

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
  it('hands a daemon of another protocol to onOtherProtocol, whose frozen commands it then serves, and rejects the connect', async () => {
    let handed: OtherProtocolDaemon | undefined;
    await expect(connect({ ...options, protocolVersion: 99, stream: await daemon.connect(), onOtherProtocol: (other) => { handed = other; } })).rejects.toBeInstanceOf(OtherProtocolError);
    expect(handed?.protocolVersion).not.toBe(99);
    expect(await handed!.control.request('listRuns', {})).toEqual({ runs: [] });
    expect(await handed!.control.request('mirror.sync', { projectKey: '/srv/none', budgetBytes: 1024, files: [] })).toEqual({ changes: [] });
    handed!.close('done');
  });

  it('hands back the daemon\'s facts once it welcomed the client and took its attach', async () => {
    const connection = await connect({ ...options, stream: await daemon.connect() });
    expect(connection.facts).toEqual(TEST_FACTS);
    expect(await connection.control.request('listRuns', {})).toEqual({ runs: [] });
    const closed = new Promise<string>((resolve) => connection.onClose(resolve));
    connection.close('done');
    expect(await closed).toBe('done');
  });

  it('runs every close listener when one throws, and logs the throw', async () => {
    const lines: string[] = [];
    const connection = await connect({ ...options, stream: await daemon.connect(), log: (line) => lines.push(line) });
    const heard: string[] = [];
    connection.onClose(() => {
      throw new Error('The app is quitting');
    });
    connection.onClose((reason) => heard.push(reason));
    connection.close('done');
    expect(heard).toEqual(['done']);
    expect(lines.some((line) => line.includes('a listener threw') && line.includes('The app is quitting'))).toBe(true);
  });

  it('ends a connection whose attach failed, so its bridge exits and the daemon stops counting it as a client', async () => {
    const stream = await daemon.connect();
    const ended = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    await expect(connect({ ...options, stream, terminalIdleDays: MAX_TERMINAL_IDLE_DAYS + 1 })).rejects.toThrow();
    await ended;
    expect(stream.destroyed).toBe(true);
  });

  it('resumes a dropped connection over a new transport inside the grace, and a request made while away is answered', async () => {
    const connection = await connect({ ...options, clientId: 'resuming', stream: await daemon.connect() });
    expect(connection.features).toContain('protocol.resume');
    const lost = new Promise<string>((resolve) => connection.onLost(resolve));
    connection.cutTransport();
    await lost;
    expect(connection.lost()).toBe(true);
    const runs = connection.control.request('listRuns', {});
    expect(await connection.resume(await daemon.connect())).toBe('resumed');
    expect(connection.lost()).toBe(false);
    expect(await runs).toEqual({ runs: [] });
    connection.close('done');
  });

  it('answers refused once the daemon no longer holds the connection, and the next connection attaches fresh', async () => {
    await daemon.shutdown();
    daemon = await startInProcessDaemon({ starters: NO_HOSTS, graceMs: 1 });
    const connection = await connect({ ...options, clientId: 'late', stream: await daemon.connect() });
    const closed = new Promise<string>((resolve) => connection.onClose(resolve));
    connection.cutTransport();
    await new Promise((resolve) => connection.onLost(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await connection.resume(await daemon.connect())).toBe('refused');
    connection.close('the daemon no longer holds it');
    expect(await closed).toBe('the daemon no longer holds it');
    const fresh = await connect({ ...options, clientId: 'late', stream: await daemon.connect() });
    expect(await fresh.control.request('listRuns', {})).toEqual({ runs: [] });
    fresh.close('done');
  });
});
