/**
 * Prefixed by the callers that run git in a folder that may be untrusted (Compass, the team fingerprint): git reads the
 * repository's own `.git/config`, and `core.fsmonitor` there names a command git runs while refreshing the index.
 */
export const GIT_HARDENING_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false'];
