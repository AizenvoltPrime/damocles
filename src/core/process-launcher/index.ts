// Every process start Damocles owns goes through the launcher (docs/invariants.md "Shell cancellation and process lifetime").
export { installProcessLauncher, LauncherWorkerDiedError, processLauncher } from './launcher';
export type { KillOptions, LaunchedProcess, Launcher, LaunchOptions, ProcessExit, SessionJob } from './launcher';
export { createLauncherPool, MAX_WORKERS, POOL_SIZE, type LauncherPoolOptions } from './pool';
export type { OutputStream, SpawnSpec, StdioMode } from './protocol';
export { runProcess, type RunOptions, type RunOutput } from './run';
export { lockThreadSpawns, withSpawnLock } from './spawn-lock';
