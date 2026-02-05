import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UUID_PATTERN } from './types';

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

  return flatPath;
}

export function buildSessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.jsonl`);
}
