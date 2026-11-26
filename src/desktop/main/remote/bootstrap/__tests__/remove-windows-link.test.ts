import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psQuote } from '../quote';
import REMOVE_WINDOWS from '../remove-windows.ps1';
import { powerShell, runPowerShell, scratchDir } from './shells';

// one function of the removal stage, as its text declares it
function definition(name: string): string {
  const start = REMOVE_WINDOWS.indexOf(`function ${name}(`);
  const end = REMOVE_WINDOWS.indexOf('\n}\n', start);
  if (start === -1 || end === -1) throw new Error(`remove-windows.ps1 declares no ${name}`);
  return REMOVE_WINDOWS.slice(start, end + 3);
}

// Remove-DamoclesEntry, run on each run folder entry, deletes the active junction itself and leaves the package it points at.
describe.skipIf(process.platform !== 'win32')('the Windows removal stage under a real Windows PowerShell', { timeout: 120_000 }, async () => {
  const shell = (await powerShell())!;

  it('removes the run folder\'s active link as a link, leaving the package it points at whole', async () => {
    const root = scratchDir('remove-link-');
    const versionDir = path.join(root, '3.8.0-win32-x64');
    mkdirSync(path.join(versionDir, 'dist'), { recursive: true });
    writeFileSync(path.join(versionDir, 'dist', 'daemon.js'), 'kept');
    const runDir = path.join(root, 'run-0123456789abcdef');
    mkdirSync(runDir);
    const link = path.join(runDir, 'active');
    symlinkSync(versionDir, link, 'junction');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'function Send-DamoclesNotice([string]$code, $params) { [Console]::Out.WriteLine("notice $code") }',
      definition('Remove-DamoclesEntry'),
      `Remove-DamoclesEntry ${psQuote(link)}`,
      '',
    ].join('\n');
    const output = await runPowerShell(shell, script);
    expect(output.exit?.code, output.stderr.toString('utf8')).toBe(0);
    expect(output.stdout.toString('utf8')).not.toContain('notice');
    expect(() => lstatSync(link)).toThrow();
    expect(readFileSync(path.join(versionDir, 'dist', 'daemon.js'), 'utf8')).toBe('kept');
    expect(existsSync(versionDir)).toBe(true);
  });
});
