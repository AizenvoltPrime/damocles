import type { DiffManager } from '../../DiffManager';
import type { FileEditInput, FileWriteInput } from '../../../shared/types/content';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, ApprovalResult, PostMessageFn } from '../types';
import { buildFileEditDenyResult, buildDenyResult, buildAllowResult } from '../utils';

export class ApprovalManager {
  private state: PermissionState;
  private diffManager: DiffManager;
  private getPostMessage: () => PostMessageFn | null;

  constructor(
    state: PermissionState,
    diffManager: DiffManager,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.diffManager = diffManager;
    this.getPostMessage = getPostMessage;
  }

  async handleFilePermission(
    toolName: string,
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    if (context.parentToolUseId && this.state.autoApprovedSubagents.has(context.parentToolUseId)) {
      return buildAllowResult(input);
    }
    if (this.state.permissionMode === 'acceptEdits' || this.state.dangerouslySkipPermissions) {
      return buildAllowResult(input);
    }

    const typedInput = input as unknown as FileEditInput | FileWriteInput;
    const result = await this.requestFilePermissionFromWebview(toolName, typedInput, context);

    if (!result.approved) {
      return buildFileEditDenyResult(result.customMessage, 'User rejected the file modification');
    }

    return buildAllowResult(input);
  }

  async handleBashPermission(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    if (context.parentToolUseId && this.state.autoApprovedSubagents.has(context.parentToolUseId)) {
      return buildAllowResult(input);
    }
    if (this.state.dangerouslySkipPermissions) {
      return buildAllowResult(input);
    }

    const result = await this.requestBashPermissionFromWebview(input, context);

    if (!result.approved) {
      return buildDenyResult(result.customMessage, 'User rejected the bash command');
    }

    return buildAllowResult(input);
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
    const diffInput = toolName === 'Write'
      ? { content: (input as FileWriteInput).content }
      : { old_string: (input as FileEditInput).old_string, new_string: (input as FileEditInput).new_string };

    const diffResult = await this.diffManager.prepareDiff(toolUseId, toolName, filePath, diffInput);
    if (!diffResult && toolName === 'Edit') {
      return { approved: false, customMessage: 'Could not find the text to replace in the file' };
    }

    const originalContent = diffResult?.originalContent || '';
    const proposedContent = diffResult?.proposedContent || '';

    await this.diffManager.showDiffView(toolUseId, filePath, originalContent, proposedContent);

    return new Promise<ApprovalResult>((resolve) => {
      const abortHandler = () => {
        this.diffManager.closeDiffView(toolUseId);
        this.state.pendingApprovals.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingApproval(toolUseId, {
        resolve,
        reject: () => resolve({ approved: false }),
        cleanup,
        diffId: toolUseId,
        parentToolUseId: context.parentToolUseId,
      });

      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestPermission',
        toolUseId,
        toolName: toolName as 'Write' | 'Edit',
        toolInput: input as unknown as Record<string, unknown>,
        filePath,
        originalContent,
        proposedContent,
        parentToolUseId: context.parentToolUseId,
        editLineNumber: diffResult?.editLineNumber,
      });
    });
  }

  private async requestBashPermissionFromWebview(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<ApprovalResult> {
    const command = typeof input.command === 'string' ? input.command : JSON.stringify(input);
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
        this.state.pendingApprovals.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingApproval(toolUseId, {
        resolve,
        reject: () => resolve({ approved: false }),
        cleanup,
        parentToolUseId: context.parentToolUseId,
      });

      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestPermission',
        toolUseId,
        toolName: 'Bash',
        toolInput: input,
        command,
        parentToolUseId: context.parentToolUseId,
      });
    });
  }

  async resolveApproval(toolUseId: string, approved: boolean, options?: { customMessage?: string }): Promise<void> {
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
      customMessage: options?.customMessage,
    });
  }
}
