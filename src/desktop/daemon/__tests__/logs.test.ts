import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { INVALID } from '../../core-protocol/schema';
import { CLIENT_TO_CONTROL } from '../control-messages';
import { listLogs, readLog } from '../logs';

let logsDir: string;

beforeEach(() => {
  logsDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-logs-')));
  fs.writeFileSync(path.join(logsDir, 'daemon.log'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(path.dirname(logsDir), 'secret.txt'), 'secret');
});

describe('the daemon logs', () => {
  it('lists its log files and reads a range of one', async () => {
    expect((await listLogs(logsDir)).map((entry) => [entry.name, entry.size])).toEqual([['daemon.log', 14]]);
    const read = await readLog(logsDir, 'daemon.log', 4, 4);
    expect(Buffer.from(read.bytes).toString()).toBe('two\n');
    expect(read.size).toBe(14);
    expect((await readLog(logsDir, 'daemon.log', 100, 10)).bytes).toHaveLength(0);
  });

  it('reads only a file in its folder, by name', async () => {
    const parse = CLIENT_TO_CONTROL.requests['logs.read'].params;
    for (const name of ['..', '../secret.txt', 'sub/daemon.log', 'sub\\daemon.log', '.hidden', '', 'C:daemon.log']) {
      expect(parse({ name, offset: 0, length: 10 })).toBe(INVALID);
      await expect(readLog(logsDir, name, 0, 10)).rejects.toThrow();
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a link in the log folder', async () => {
    fs.symlinkSync(path.join(path.dirname(logsDir), 'secret.txt'), path.join(logsDir, 'link.log'));
    await expect(readLog(logsDir, 'link.log', 0, 10)).rejects.toThrow(/not a log file/);
    expect((await listLogs(logsDir)).map((entry) => entry.name)).toEqual(['daemon.log']);
  });
});
