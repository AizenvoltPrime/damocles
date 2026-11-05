import * as path from 'node:path';
import { isSafeAgentPathId } from '../../../shared/agent-path-id';
import { folderKey } from '../../workspace-folders/folder-key';

/** pi's agent folder in a Damocles home; PI_AGENT_DIR is this computer's. */
export function piAgentDirIn(damoclesHome: string): string {
  return path.join(damoclesHome, 'pi', 'agent');
}

/** The folder every pi session dir lies directly in. */
export function sessionsRootIn(agentDir: string): string {
  return path.join(path.resolve(agentDir), 'sessions');
}

// pi names a session file `<timestamp>_<sessionId>.jsonl` and its timestamp holds no `_` (`session-manager.js:713`, `:1241`, `:1396` in pi 1.4.0).
const SESSION_FILE_NAME = /^[^_]+_(.+)\.jsonl$/;

/** The pi session id a file's name carries; undefined for a name pi does not give a session file. */
export function piSessionFileId(filePath: string): string | undefined {
  const id = SESSION_FILE_NAME.exec(path.basename(filePath))?.[1];
  return id !== undefined && isSafeAgentPathId(id) ? id : undefined;
}

/** A file of a session store: a chat's session file, or a subagent's or team member's (agent-records.ts). */
export interface SessionFileKind {
  readonly kind: 'chat' | 'agent';
  // pi's session id, read from the file's name, which keys the file's lease
  readonly sessionId: string;
}

/**
 * Whether a canonical path names a session file below a canonical sessions root, compared as folder keys of this machine:
 * `<dir>/<file>` for a chat, `<dir>/<parent>/subagents/<file>` and `<dir>/<parent>/teams/<team>/members/<file>` for an agent.
 * Both paths must already be canonical (links followed, native spelling), or a link or another spelling escapes it.
 */
export function sessionFileAt(canonicalFile: string, canonicalRoot: string): SessionFileKind | undefined {
  const relative = path.relative(folderKey(canonicalRoot), folderKey(canonicalFile));
  const parts = relative.split(path.sep);
  if (relative === '' || path.isAbsolute(relative) || parts[0] === '..') return undefined;
  const sessionId = piSessionFileId(canonicalFile);
  if (sessionId === undefined) return undefined;
  if (parts.length === 2) return { kind: 'chat', sessionId };
  const agent = (parts.length === 4 && parts[2] === 'subagents') || (parts.length === 6 && parts[2] === 'teams' && parts[4] === 'members');
  return agent ? { kind: 'agent', sessionId } : undefined;
}
