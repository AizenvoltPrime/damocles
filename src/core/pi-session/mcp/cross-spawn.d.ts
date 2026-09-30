/*
 * Minimal ambient types for `cross-spawn` (the package ships no types and `@types/cross-spawn`
 * is not installed). Only the surface this codebase uses is declared. cross-spawn is required on
 * Windows because Node's `child_process.spawn`/`spawnSync` neither resolve `npm` → `npm.cmd` via
 * PATHEXT (ENOENT) nor allow spawning a `.cmd` without a shell (EINVAL since the CVE-2024-27980 fix);
 * cross-spawn launches it through `cmd.exe` with injection-safe argument escaping.
 */
declare module 'cross-spawn' {
  import type {
    ChildProcess,
    SpawnOptions,
    SpawnSyncOptions,
    SpawnSyncReturns,
  } from 'node:child_process';

  interface CrossSpawn {
    (command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
    sync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string>;
  }

  const crossSpawn: CrossSpawn;
  export default crossSpawn;
}
