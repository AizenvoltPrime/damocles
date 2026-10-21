/*
 * The part of `cross-spawn` (no bundled types) the launcher worker uses. Node's spawn neither finds `npx` as `npx.cmd`
 * through PATHEXT nor starts a .cmd without a shell (EINVAL since CVE-2024-27980); cross-spawn's parse rewrites such a
 * start into `cmd.exe /d /s /c` with escaped arguments.
 */
declare module 'cross-spawn' {
  import type { SpawnOptions } from 'node:child_process';

  interface ParsedStart {
    command: string;
    args: string[];
    options: SpawnOptions;
    // the resolved file; undefined on Windows when no file matched, so cmd.exe's exit code 1 means not found
    file?: string;
    original: { command: string; args: string[] };
  }

  interface CrossSpawn {
    _parse(command: string, args: readonly string[], options: SpawnOptions): ParsedStart;
    _enoent: { notFoundError(original: ParsedStart['original'], syscall: string): NodeJS.ErrnoException };
  }

  const crossSpawn: CrossSpawn;
  export default crossSpawn;
}
