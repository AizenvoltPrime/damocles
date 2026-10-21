import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { runProcess } from '../index';

const node = (script: string) => ({ file: process.execPath, args: ['-e', script] });

describe('runProcess', () => {
  it('collects both outputs and the exit, and feeds stdin', async () => {
    const run = await runProcess(node("process.stdin.on('data', (d) => process.stdout.write(d)); process.stderr.write('e'); process.exitCode = 3;"), { input: 'in' });
    expect(run.exit).toEqual({ code: 3, signal: null });
    expect([run.stdout.toString(), run.stderr.toString()]).toEqual(['in', 'e']);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('resolves at the timeout with what was printed, and kills the process', async () => {
    const run = await runProcess(node("process.stdout.write(String(process.pid)); setInterval(() => undefined, 1000);"), { timeoutMs: 1_000 });
    expect(run.exit).toBeNull();
    const pid = Number(run.stdout.toString());
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: SPAWN_TEST_TIMEOUT_MS }).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS * 2);

  it('rejects at once with the abort reason when aborted after the start, and kills the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-run-'));
    const pidFile = path.join(dir, 'pid');
    try {
      const controller = new AbortController();
      const reason = new Error('stopped');
      const run = runProcess(node(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => undefined, 1000);`), { signal: controller.signal });
      await expect.poll(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', { timeout: SPAWN_TEST_TIMEOUT_MS }).toBe(true);
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await expect.poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: SPAWN_TEST_TIMEOUT_MS }).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, SPAWN_TEST_TIMEOUT_MS * 2);

  it('rejects with the start error when the file cannot start', async () => {
    await expect(runProcess({ file: `${process.execPath}-missing`, args: [] })).rejects.toMatchObject({ code: 'ENOENT' });
  }, SPAWN_TEST_TIMEOUT_MS);
});
