import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { processLauncher } from '../../../../../core/process-launcher';
import { psQuote } from '../quote';
import { powerShell, runPowerShell, scratchDir, withWindowsDefinitions } from './shells';

// Windows refuses to rename a folder while a file in it is open without delete sharing; other systems never do.
describe.skipIf(process.platform !== 'win32')('Windows stage 1 moves the unpacked package under a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = (await powerShell())!;

  const folders = (): { readonly from: string; readonly to: string; readonly held: string } => {
    const root = scratchDir('stage-move-');
    const from = path.join(root, 'package');
    mkdirSync(from);
    const held = path.join(from, 'node.exe');
    writeFileSync(held, 'x');
    return { from, to: path.join(root, '3.7.0-win32-x64'), held };
  };

  // Another process opens the file without sharing, as a scan does, and closes it after holdMs.
  const hold = async (file: string, holdMs: number): Promise<{ readonly released: Promise<unknown> }> => {
    const opened = `${file}.opened`;
    const script = `$h = [IO.File]::Open(${psQuote(file)}, 'Open', 'Read', 'None'); [IO.File]::WriteAllText(${psQuote(opened)}, ''); Start-Sleep -Milliseconds ${holdMs}; $h.Dispose()`;
    const child = processLauncher().launch({ file: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    while (!existsSync(opened)) await new Promise((resolve) => setTimeout(resolve, 20));
    return { released: child.exited };
  };

  it('waits out a file held open in the folder, then moves it', async () => {
    const { from, to, held } = folders();
    const { released } = await hold(held, 1500);
    const started = Date.now();
    const output = await runPowerShell(shell, withWindowsDefinitions(`Move-DamoclesFolder ${psQuote(from)} ${psQuote(to)}`));
    expect(output.exit?.code, output.stderr.toString('utf8')).toBe(0);
    // the first try met the held file, so the move landed only once it was let go
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(existsSync(path.join(to, 'node.exe'))).toBe(true);
    expect(existsSync(from)).toBe(false);
    await released;
  });

  it('fails at once on an error no wait can clear', async () => {
    const { from, to } = folders();
    mkdirSync(to);
    const started = Date.now();
    const output = await runPowerShell(shell, withWindowsDefinitions(`Move-DamoclesFolder ${psQuote(from)} ${psQuote(to)}`));
    expect(output.exit?.code).not.toBe(0);
    expect(output.stderr.toString('utf8')).toMatch(/already exists/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(from)).toBe(true);
  });
});
