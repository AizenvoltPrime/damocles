/**
 * Prefixed by the callers that run git outside the engine's runner, in a folder that may be untrusted (Compass, the team
 * fingerprint): git reads the repository's own `.git/config`, and `core.fsmonitor` there names a command git runs while
 * refreshing the index. It also turns on `core.longpaths`, as the runner does (`gitEnv`), because the folder may be a chat worktree.
 */
export const GIT_HARDENING_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
