// The terminal hosts' retry timing (terminal-hosts.ts); a leaf module: it imports nothing but the handshake's bound.
import { AUTH_TIMEOUT_MS } from '../../remote/handshake';

// how often a live host that did not answer is tried again, and an attached one must answer a list
export const HOST_RETRY_MS = 30_000;
// How long a new terminal waits for the host of this version whose link was lost: the attempt at once and one retry. Past
// it a second host of the version starts, and any lost host whose pid lives is not responding.
export const HOST_REATTACH_WAIT_MS: number = HOST_RETRY_MS + 2 * AUTH_TIMEOUT_MS;
