import * as vscode from 'vscode';
import type { PermissionState } from '../state';
import type { PermissionBehavior } from '../../../shared/types/permissions';
import { loadPermissionsByPriority, type FilePermissions } from '../../claude-settings';

export class EvaluatorManager {
  private state: PermissionState;
  private cachedPermissions: FilePermissions[] | null = null;
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;
  private settingsWatcher: vscode.FileSystemWatcher | null = null;

  constructor(state: PermissionState) {
    this.state = state;
    this.setupSettingsWatcher();
  }

  private setupSettingsWatcher(): void {
    this.settingsWatcher = vscode.workspace.createFileSystemWatcher(
      '**/.claude/settings*.json'
    );
    const invalidate = () => { this.cachedPermissions = null; };
    this.settingsWatcher.onDidChange(invalidate);
    this.settingsWatcher.onDidCreate(invalidate);
    this.settingsWatcher.onDidDelete(invalidate);
  }

  async evaluate(
    toolName: string,
    input: Record<string, unknown>,
    workspacePath: string | null
  ): Promise<PermissionBehavior> {
    if (this.state.dangerouslySkipPermissions) {
      return 'allow';
    }

    if (toolName.startsWith('mcp__')) {
      return 'allow';
    }

    const permissions = await this.getPermissions(workspacePath);
    const patternResult = this.matchAgainstPatterns(toolName, input, permissions);

    if (patternResult === 'deny') {
      return 'deny';
    }

    if (patternResult === 'allow') {
      return 'allow';
    }

    if (this.state.permissionMode === 'default') {
      const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'LSP'];
      if (readOnlyTools.includes(toolName)) {
        return 'allow';
      }
      return 'ask';
    }

    if (this.state.permissionMode === 'acceptEdits') {
      if (toolName === 'Edit' || toolName === 'Write') {
        return 'allow';
      }
      return 'ask';
    }

    return 'ask';
  }

  private async getPermissions(workspacePath: string | null): Promise<FilePermissions[]> {
    const now = Date.now();
    if (this.cachedPermissions && (now - this.cacheTime) < this.CACHE_TTL_MS) {
      return this.cachedPermissions;
    }
    this.cachedPermissions = await loadPermissionsByPriority(workspacePath);
    this.cacheTime = now;
    return this.cachedPermissions;
  }

  private matchAgainstPatterns(
    toolName: string,
    input: Record<string, unknown>,
    permissionsByFile: FilePermissions[]
  ): PermissionBehavior {
    for (const filePerms of permissionsByFile) {
      for (const behavior of ['deny', 'allow', 'ask'] as PermissionBehavior[]) {
        for (const pattern of filePerms[behavior]) {
          if (this.matchesPattern(toolName, input, pattern)) {
            return behavior;
          }
        }
      }
    }
    return 'ask';
  }

  private matchesPattern(
    toolName: string,
    input: Record<string, unknown>,
    pattern: string
  ): boolean {
    const match = pattern.match(/^(\w+)(?:\((.+)\))?$/);
    if (!match) return false;

    const [, patternTool, specifier] = match;
    if (patternTool !== toolName) return false;
    if (!specifier) return true;

    if (toolName === 'Bash') {
      return this.matchBashSpecifier(input, specifier);
    }
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
      return this.matchFileSpecifier(input, specifier);
    }
    return false;
  }

  private matchBashSpecifier(input: Record<string, unknown>, specifier: string): boolean {
    const command = typeof input['command'] === 'string' ? input['command'] : '';

    if (specifier.endsWith(':*')) {
      const prefix = specifier.slice(0, -2);
      return command.startsWith(prefix);
    }

    if (specifier.endsWith(' *')) {
      const prefix = specifier.slice(0, -2);
      return command.startsWith(prefix + ' ') || command === prefix;
    }

    return command === specifier;
  }

  private matchFileSpecifier(input: Record<string, unknown>, specifier: string): boolean {
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
    if (!filePath) return false;

    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedSpec = specifier.replace(/\\/g, '/');

    return this.simpleGlobMatch(normalizedPath, normalizedSpec);
  }

  private simpleGlobMatch(path: string, pattern: string): boolean {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      const basename = path.split('/').pop() ?? '';
      return basename === pattern;
    }

    try {
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');

      const regex = new RegExp(`(^|/)${regexStr}$`);
      return regex.test(path);
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.settingsWatcher?.dispose();
  }
}
