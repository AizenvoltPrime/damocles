import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { assemblyInfo, compileAskpassTrampoline, cscPath } from '../askpass-trampoline.mjs';

describe('the askpass trampoline build', () => {
  it('writes the release version as FileVersion and its four-part form as the assembly and product versions', () => {
    const info = assemblyInfo('3.8.0') as string;
    expect(info).toContain('[assembly: AssemblyProduct("Damocles")]');
    expect(info).toContain('[assembly: AssemblyVersion("3.8.0.0")]');
    expect(info).toContain('[assembly: AssemblyFileVersion("3.8.0")]');
    expect(info).toContain('[assembly: AssemblyInformationalVersion("3.8.0.0")]');
  });

  it('writes a prerelease version\'s numbers only, which csc takes as a file version', () => {
    const info = assemblyInfo('3.8.0-beta.1') as string;
    expect(info).toContain('[assembly: AssemblyFileVersion("3.8.0")]');
    expect(info).not.toContain('beta');
    expect(() => assemblyInfo('next')).toThrow('next is not a release version');
  });

  it('finds csc under a local absolute SystemRoot only', () => {
    expect(cscPath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    expect(cscPath({ windir: 'C:\\Windows' })).toBe('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    for (const SystemRoot of ['Windows', '\\Windows', '\\\\host\\share\\Windows', '']) expect(() => cscPath({ SystemRoot }), SystemRoot).toThrow('local absolute path');
  });

  // a runner image without .NET Framework 4's compiler must fail the build at once, naming the path it looked for
  it('fails a Windows build on a machine without csc.exe', () => {
    expect(() => compileAskpassTrampoline('unused', 'win32', { SystemRoot: 'C:\\no-such-windows' }))
      .toThrow('C:\\no-such-windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe is missing');
  });

  it('compiles nothing off Windows', () => {
    expect(compileAskpassTrampoline('unused', 'linux', {})).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('compiles a prerelease version under /warnaserror+', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'trampoline-prerelease-'));
    try {
      const exe = compileAskpassTrampoline(dir, 'win32', process.env, '3.8.0-beta.1') as string;
      expect(exe).toBe(join(dir, 'ssh-askpass.exe'));
      expect(existsSync(exe)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
