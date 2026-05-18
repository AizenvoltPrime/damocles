import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UUID_PATTERN } from './types';
import { DAMOCLES_EXPLORES_DIR, workspaceHash } from '../auth/paths';

export function isValidSessionId(sessionId: string): boolean {
  return UUID_PATTERN.test(sessionId);
}

export function getClaudeProjectsDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.claude', 'projects');
}

export function encodeProjectPath(workspacePath: string): string {
  if (workspacePath.includes('..')) {
    throw new Error('Invalid workspace path: path traversal not allowed');
  }

  let normalized = workspacePath.replace(/\\/g, '/').replace(/\/$/, '');

  if (/^[a-z]:/.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  normalized = normalized.replace(/:/g, '-').replace(/\//g, '-').replace(/ /g, '-').replace(/_/g, '-');

  return normalized;
}

export async function getSessionDir(workspacePath: string): Promise<string> {
  const projectsDir = getClaudeProjectsDir();
  const encodedPath = encodeProjectPath(workspacePath);
  return path.join(projectsDir, encodedPath);
}

export function getSessionDirSync(workspacePath: string): string {
  const projectsDir = getClaudeProjectsDir();
  const encodedPath = encodeProjectPath(workspacePath);
  return path.join(projectsDir, encodedPath);
}

export async function ensureSessionDir(workspacePath: string): Promise<string> {
  const sessionDir = await getSessionDir(workspacePath);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

export async function getSessionFilePath(workspacePath: string, sessionId: string): Promise<string> {
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID format');
  }
  const sessionDir = await getSessionDir(workspacePath);
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

export async function getAgentFilePath(workspacePath: string, agentId: string): Promise<string> {
  const sessionDir = await getSessionDir(workspacePath);
  const flatPath = path.join(sessionDir, `agent-${agentId}.jsonl`);

  try {
    await fs.promises.access(flatPath, fs.constants.R_OK);
    return flatPath;
  } catch {
  }

  const entries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && UUID_PATTERN.test(entry.name)) {
      const nestedPath = path.join(sessionDir, entry.name, 'subagents', `agent-${agentId}.jsonl`);
      try {
        await fs.promises.access(nestedPath, fs.constants.R_OK);
        return nestedPath;
      } catch {
      }
    }
  }

  const explorePath = await findExploreAgentFile(workspacePath, agentId);
  if (explorePath) return explorePath;

  return flatPath;
}

async function findExploreAgentFile(workspacePath: string, agentId: string): Promise<string | null> {
  const exploreWorkspaceDir = path.join(DAMOCLES_EXPLORES_DIR, workspaceHash(workspacePath));
  let sessions: fs.Dirent[];
  try {
    sessions = await fs.promises.readdir(exploreWorkspaceDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const candidate = path.join(exploreWorkspaceDir, session.name, `${agentId}.jsonl`);
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}

export function buildSessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

export function buildNodeFilePath(sessionDir: string, sessionId: string, nodeId: string): string {
  if (!UUID_PATTERN.test(nodeId)) {
    throw new Error('Invalid node ID format');
  }
  return path.join(sessionDir, sessionId, 'nodes', `${nodeId}.jsonl`);
}

export function buildTeamFilePath(sessionDir: string, sessionId: string, teamId: string): string {
  if (!UUID_PATTERN.test(teamId)) {
    throw new Error('Invalid team ID format');
  }
  return path.join(sessionDir, sessionId, 'teams', `${teamId}.jsonl`);
}

export function buildTeamAgentFilePath(sessionDir: string, sessionId: string, agentId: string): string {
  if (!UUID_PATTERN.test(agentId)) {
    throw new Error('Invalid agent ID format');
  }
  return path.join(sessionDir, sessionId, 'teams', 'agents', `${agentId}.jsonl`);
}
