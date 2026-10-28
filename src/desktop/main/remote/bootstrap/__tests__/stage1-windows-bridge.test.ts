import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { powerShell, runPowerShell, withWindowsDefinitions } from './shells';

// a pid no process holds: above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
const GONE_PID = 4_194_305;

describe('the Windows bridge\'s pid records under a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();

  it.skipIf(shell === undefined)('takes a record as a crashed daemon\'s only when it names a process of this host that has ended', async () => {
    const gone = (hostname: string, pid: number): string => `Write-Output (Test-DamoclesRecordGone ([pscustomobject]@{ hostname = '${hostname}'; pid = ${pid} }))`;
    const output = await runPowerShell(shell!, withWindowsDefinitions([gone(os.hostname(), GONE_PID), gone(os.hostname(), process.pid), gone('another-host', GONE_PID)].join('\n')));
    expect(output.exit?.code).toBe(0);
    expect(output.stdout.toString('utf8').split(/\r?\n/).filter(Boolean)).toEqual(['True', 'False', 'False']);
  });
});
