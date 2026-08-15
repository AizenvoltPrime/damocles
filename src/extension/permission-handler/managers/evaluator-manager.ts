import * as vscode from 'vscode';
import type { PermissionState } from '../state';
import type { PermissionBehavior } from '../../../shared/types/permissions';
import { loadPermissionsByPriority, type FilePermissions } from '../permission-settings';
import { READ_ONLY_TOOLS, ORCHESTRATION_TOOLS, TOOL_EDIT, TOOL_WRITE, TOOL_READ, SHELL_TOOLS } from '../../../shared/tool-names';
import { isPlanFilePath } from '../../paths';

export class EvaluatorManager {
  private state: PermissionState;
  private cachedPermissions: FilePermissions[] | null = null;
  private cachedFor: string | null = null;
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;
  private settingsWatchers: vscode.FileSystemWatcher[] = [];

  constructor(state: PermissionState) {
    this.state = state;
    this.setupSettingsWatcher();
  }

  private setupSettingsWatcher(): void {
    const invalidate = () => { this.cachedPermissions = null; };
    // createFileSystemWatcher takes a single pattern, so each settings directory needs its own watcher.
    for (const pattern of ['**/.claude/settings*.json', '**/.damocles/settings*.json']) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);
      this.settingsWatchers.push(watcher);
    }
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

    if (toolName === TOOL_EDIT || toolName === TOOL_WRITE) {
      const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
      if (isPlanFilePath(filePath)) {
        return 'allow';
      }
    }

    const permissions = await this.getPermissions(workspacePath);
    const patternResult = this.matchAgainstPatterns(toolName, input, permissions);

    if (patternResult === 'deny') {
      return 'deny';
    }

    if (patternResult === 'allow') {
      return 'allow';
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return 'allow';
    }

    if (ORCHESTRATION_TOOLS.has(toolName)) {
      return 'allow';
    }

    if (this.state.permissionMode === 'acceptEdits') {
      if (toolName === TOOL_EDIT || toolName === TOOL_WRITE) {
        return 'allow';
      }
    }

    return 'ask';
  }

  /**
   * Cached per workspace, not just per age: the eight paths this resolves are half workspace-relative,
   * so a hit for a different workspace would answer with another project's rules. One handler serves
   * one workspace today, which is why this has never bitten — the key makes that an invariant rather
   * than a coincidence.
   */
  private async getPermissions(workspacePath: string | null): Promise<FilePermissions[]> {
    const now = Date.now();
    if (
      this.cachedPermissions &&
      this.cachedFor === workspacePath &&
      (now - this.cacheTime) < this.CACHE_TTL_MS
    ) {
      return this.cachedPermissions;
    }
    this.cachedPermissions = await loadPermissionsByPriority(workspacePath);
    this.cachedFor = workspacePath;
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

    if (SHELL_TOOLS.has(toolName)) {
      return this.matchShellSpecifier(input, specifier);
    }
    if (toolName === TOOL_EDIT || toolName === TOOL_WRITE || toolName === TOOL_READ) {
      return this.matchFileSpecifier(input, specifier);
    }
    return false;
  }

  private matchShellSpecifier(input: Record<string, unknown>, specifier: string): boolean {
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
    for (const watcher of this.settingsWatchers) {
      watcher.dispose();
    }
    this.settingsWatchers = [];
  }
}
