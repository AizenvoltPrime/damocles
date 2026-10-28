import { createHash } from 'node:crypto';
import * as path from 'node:path';

// 96 bits of the client id's SHA-256: hex, since macOS folders are case-insensitive, and short enough that
// <TMPDIR>/damocles-XXXXXX/agent-<24 hex>.sock stays within macOS's 103-byte sun_path
const HASH_HEX_CHARS = 24;

/** The file of a client's forwarded-agent proxy socket in the daemon's agent folder (CoreInit.remote.agentFolder). */
export function agentSocketName(clientId: string): string {
  return `agent-${createHash('sha256').update(clientId, 'utf8').digest('hex').slice(0, HASH_HEX_CHARS)}.sock`;
}

export function agentSocketFile(agentFolder: string, clientId: string): string {
  return path.join(agentFolder, agentSocketName(clientId));
}
