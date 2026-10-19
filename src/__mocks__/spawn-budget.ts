// A test awaiting a few short-lived real processes (git, a shell, node, esbuild's service): about four times the slowest
// single spawn seen on Windows while the full suite runs in parallel.
export const SPAWN_TEST_TIMEOUT_MS = 15_000;
