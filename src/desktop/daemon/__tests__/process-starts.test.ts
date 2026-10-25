import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forkChild } from '../process-starts';

const GRANDCHILD_HOLD_MS = 30_000;

describe('a forked child of the daemon', () => {
  it('reports its exit and stderr tail while a grandchild still holds its stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fork-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const entry = path.join(dir, 'child.js');
    // as an MCP server started with stderr 'inherit' outlives the core that started it; detached, so no Windows job ends it
    fs.writeFileSync(entry, `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, ${GRANDCHILD_HOLD_MS})'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      process.stderr.write('boom', () => process.exit(3));
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = forkChild(entry, [], env);
    const started = Date.now();
    const exit = await new Promise<{ code: number; error: string | null }>((resolve) => child.onExit(resolve));
    try {
      expect(Date.now() - started).toBeLessThan(GRANDCHILD_HOLD_MS / 2);
      expect(exit.code).toBe(3);
      expect(exit.error).toBe('boom');
    } finally {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
