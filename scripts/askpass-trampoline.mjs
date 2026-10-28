// Builds dist/askpass/ssh-askpass.exe, the SSH_ASKPASS Windows ssh runs (resources/askpass/ssh-askpass.cs), with .NET
// Framework 4's csc.exe, which every supported Windows and the windows-latest runners carry. Only a Windows build compiles it;
// a Windows build without csc.exe fails, since an app without the trampoline cannot answer any ssh prompt.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TRAMPOLINE_SOURCE = 'resources/askpass/ssh-askpass.cs';
export const TRAMPOLINE_NAME = 'ssh-askpass.exe';

/** csc.exe of .NET Framework 4 under %SystemRoot%, by absolute path; a relative, root-relative or UNC root is refused. */
export function cscPath(env = process.env) {
  const root = env.SystemRoot ?? env.windir;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('SystemRoot is not set to a local absolute path, so csc.exe cannot be found');
  return win32.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
}

/**
 * The version resource SignPath's metadata condition checks: ProductName Damocles, FileVersion the release version and
 * ProductVersion its four-part form, as electron-builder writes them into Damocles.exe. AssemblyFileVersion takes numbers
 * only (csc's CS1607 under /warnaserror+), so a prerelease version's FileVersion is its x.y.z part.
 */
export function assemblyInfo(version) {
  const numeric = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!numeric) throw new Error(`${version} is not a release version`);
  const three = `${numeric[1]}.${numeric[2]}.${numeric[3]}`;
  return [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("Damocles SSH askpass")]',
    '[assembly: AssemblyProduct("Damocles")]',
    '[assembly: AssemblyCompany("AizenvoltPrime")]',
    `[assembly: AssemblyVersion("${three}.0")]`,
    `[assembly: AssemblyFileVersion("${three}")]`,
    `[assembly: AssemblyInformationalVersion("${three}.0")]`,
    '',
  ].join('\n');
}

const packageVersion = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** Compiles the trampoline into `dir` (relative to the repository) on Windows; elsewhere nothing, since only Windows ssh runs it. */
export function compileAskpassTrampoline(dir = 'dist/askpass', platform = process.platform, env = process.env, version = packageVersion()) {
  if (platform !== 'win32') return undefined;
  const csc = cscPath(env);
  if (!existsSync(csc)) throw new Error(`${csc} is missing: the Windows build compiles ${TRAMPOLINE_SOURCE} with .NET Framework 4's csc.exe`);
  const scratch = mkdtempSync(join(tmpdir(), 'damocles-askpass-'));
  try {
    const info = join(scratch, 'AssemblyInfo.cs');
    writeFileSync(info, assemblyInfo(version));
    const outDir = resolve(ROOT, dir);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, TRAMPOLINE_NAME);
    // csc reads a forward slash as an option, so every path is absolute with backslashes
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/warnaserror+', `/out:${win32.resolve(out)}`, win32.resolve(ROOT, TRAMPOLINE_SOURCE), win32.resolve(info)], { stdio: 'inherit' });
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
