import type { DiffManager } from '../diff-manager';
import type { FileEditInput, FileWriteInput } from '../../../shared/types/content';
import type { PermissionUpdate } from '../../../shared/types/permissions';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, ApprovalResult, PostMessageFn, PermissionRequiredNotifier } from '../types';
import { buildFileEditDenyResult, buildDenyResult, buildAllowResult } from '../utils';
import { TOOL_WRITE, TOOL_EDIT, SHELL_TOOLS, type ShellToolName } from '../../../shared/tool-names';
import { log } from '../../logger';

/**
 * Generate permission pattern suggestions in Claude Code CLI format.
 * Only generates suggestions for shell commands (e.g., `Bash(git:*)`, `PowerShell(Get-ChildItem:*)`).
 * Edit/Write tools use diff view approval instead of persistent rules.
 */
function generatePatternSuggestions(toolName: string, input: Record<string, unknown>): PermissionUpdate[] {
  if (!SHELL_TOOLS.has(toolName)) return [];

  const command = typeof input['command'] === 'string' ? input['command'] : '';
  const firstWord = command.split(/\s+/)[0] || '';
  if (!firstWord) return [];

  return [{
    type: 'addRules' as const,
    rules: [{ toolName, ruleContent: `${firstWord}:*` }],
    behavior: 'allow' as const,
    destination: 'localSettings' as const,
  }];
}

export class ApprovalManager {
  private state: PermissionState;
  private diffManager: DiffManager;
  private getPostMessage: () => PostMessageFn | null;
  private getNotifier: () => PermissionRequiredNotifier | null;

  constructor(
    state: PermissionState,
    diffManager: DiffManager,
    getPostMessage: () => PostMessageFn | null,
    getNotifier: () => PermissionRequiredNotifier | null = () => null
  ) {
    this.state = state;
    this.diffManager = diffManager;
    this.getPostMessage = getPostMessage;
    this.getNotifier = getNotifier;
  }

  async handleFilePermission(
    toolName: string,
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    if (context.parentToolUseId && this.state.autoApprovedSubagents.has(context.parentToolUseId)) {
      return buildAllowResult(input);
    }

    const typedInput = input as unknown as FileEditInput | FileWriteInput;
    const result = await this.requestFilePermissionFromWebview(toolName, typedInput, context);

    if (!result.approved) {
      return buildFileEditDenyResult(result.customMessage, 'User rejected the file modification');
    }

    return {
      ...buildAllowResult(input),
      ...(result.updatedPermissions?.length ? { updatedPermissions: result.updatedPermissions } : {}),
    };
  }

  async handleShellPermission(
    toolName: ShellToolName,
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    if (context.parentToolUseId && this.state.autoApprovedSubagents.has(context.parentToolUseId)) {
      return buildAllowResult(input);
    }

    const result = await this.requestShellPermissionFromWebview(toolName, input, context);

    if (!result.approved) {
      return buildDenyResult(result.customMessage, 'User rejected the shell command');
    }

    return {
      ...buildAllowResult(input),
      ...(result.updatedPermissions?.length ? { updatedPermissions: result.updatedPermissions } : {}),
    };
  }

  private async requestFilePermissionFromWebview(
    toolName: string,
    input: FileEditInput | FileWriteInput,
    context: CanUseToolContext
  ): Promise<ApprovalResult> {
    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { approved: false, customMessage: 'Cannot request permission: webview not available' };
    }

    const toolUseId = context.toolUseID;
    if (!toolUseId) {
      return { approved: false, customMessage: 'Cannot request permission: no tool use ID' };
    }

    const filePath = input.file_path;
    const diffInput = toolName === TOOL_WRITE
      ? { content: (input as FileWriteInput).content }
      : { old_string: (input as FileEditInput).old_string, new_string: (input as FileEditInput).new_string };

    const diffResult = await this.diffManager.prepareDiff(toolUseId, toolName, filePath, diffInput);
    if (!diffResult && toolName === TOOL_EDIT) {
      return { approved: false, customMessage: 'Could not find the text to replace in the file' };
    }

    const originalContent = diffResult?.originalContent || '';
    const proposedContent = diffResult?.proposedContent || '';

    await this.diffManager.showDiffView(toolUseId, filePath, originalContent, proposedContent);

    return new Promise<ApprovalResult>((resolve) => {
      const abortHandler = () => {
        const approved = !this.state.sessionAborting;
        log('[ApprovalManager] Abort signal on file approval: toolUseId=%s, approved=%s', toolUseId, approved);
        this.diffManager.closeDiffView(toolUseId);
        this.state.pendingApprovals.delete(toolUseId);
        this.getPostMessage()?.({
          type: 'permissionAutoResolved',
          toolUseId,
          ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        });
        resolve({ approved });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingApproval(toolUseId, {
        resolve,
        reject: () => resolve({ approved: false }),
        cleanup,
        diffId: toolUseId,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      });

      context.signal.addEventListener('abort', abortHandler, { once: true });

      this.getNotifier()?.({
        toolName,
        toolInput: input as unknown as Record<string, unknown>,
        message: `Damocles is waiting for your approval to ${toolName === TOOL_WRITE ? 'create' : 'edit'} ${filePath}`,
        filePath,
        ...(context.parentToolUseId != null ? { parentToolUseId: context.parentToolUseId } : {}),
      });

      const suggestions = generatePatternSuggestions(toolName, input as unknown as Record<string, unknown>);
      postMessage({
        type: 'requestPermission',
        toolUseId,
        toolName: toolName as 'Write' | 'Edit',
        toolInput: input as unknown as Record<string, unknown>,
        filePath,
        originalContent,
        proposedContent,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        ...(diffResult?.editLineNumber !== undefined ? { editLineNumber: diffResult.editLineNumber } : {}),
        ...(suggestions.length ? { suggestions } : {}),
        ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}),
        ...(context.decisionReason ? { decisionReason: context.decisionReason } : {}),
      });
    });
  }

  private async requestShellPermissionFromWebview(
    toolName: ShellToolName,
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<ApprovalResult> {
    const command = typeof input['command'] === 'string' ? input['command'] : JSON.stringify(input);
    const postMessage = this.getPostMessage();

    if (!postMessage) {
      return { approved: false, customMessage: 'Cannot request permission: webview not available' };
    }

    const toolUseId = context.toolUseID;
    if (!toolUseId) {
      return { approved: false, customMessage: 'Cannot request permission: no tool use ID' };
    }

    return new Promise<ApprovalResult>((resolve) => {
      const abortHandler = () => {
        const approved = !this.state.sessionAborting;
        log('[ApprovalManager] Abort signal on shell approval: toolUseId=%s, approved=%s', toolUseId, approved);
        this.state.pendingApprovals.delete(toolUseId);
        this.getPostMessage()?.({
          type: 'permissionAutoResolved',
          toolUseId,
          ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        });
        resolve({ approved });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingApproval(toolUseId, {
        resolve,
        reject: () => resolve({ approved: false }),
        cleanup,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      });

      context.signal.addEventListener('abort', abortHandler, { once: true });

      this.getNotifier()?.({
        toolName,
        toolInput: input,
        message: `Damocles is waiting for your approval to run: ${command}`,
        command,
        ...(context.parentToolUseId != null ? { parentToolUseId: context.parentToolUseId } : {}),
      });

      const suggestions = generatePatternSuggestions(toolName, input);
      postMessage({
        type: 'requestPermission',
        toolUseId,
        toolName,
        toolInput: input,
        command,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        ...(suggestions.length ? { suggestions } : {}),
        ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}),
        ...(context.decisionReason ? { decisionReason: context.decisionReason } : {}),
      });
    });
  }

  async resolveApproval(
    toolUseId: string,
    approved: boolean,
    options?: { customMessage?: string; updatedPermissions?: PermissionUpdate[] }
  ): Promise<void> {
    const pending = this.state.removePendingApproval(toolUseId);
    if (!pending) {
      return;
    }

    if (pending.diffId) {
      await this.diffManager.closeDiffView(pending.diffId);
    }

    pending.cleanup();
    pending.resolve({
      approved,
      ...(options?.customMessage !== undefined ? { customMessage: options.customMessage } : {}),
      ...(options?.updatedPermissions?.length ? { updatedPermissions: options.updatedPermissions } : {}),
    });
  }
}
