import * as path from 'path';
import { parsePatch } from 'diff';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PendingPromptOwner, PromptOwner } from '../../shared/types/permissions';
import { TOOL_EDIT, TOOL_GENERATE_IMAGE, TOOL_WRITE, isShellTool } from '../../shared/tool-names';
import type { PendingPrompt, RaisedPrompt } from './session-state';
import { AGENT_NAME_MAX_CHARS, agentLabel } from './extension-ui-context';
import { oneLine } from './untrusted-text';
import { t } from '../l10n';
import { log } from '../logger';

/** The longest summary a notification shows; longer text ends in an ellipsis. */
export const PROMPT_SUMMARY_MAX_CHARS = 160;

/** Who a prompt's `parentToolUseId` names: a member of the running team, or a subagent by its `Agent` call. */
export interface PromptOwners {
  teamMember(agentId: string): { teamId: string; teamTitle: string; agentName: string } | null;
  subagentOfToolCall(toolCallId: string): string | undefined;
}

/**
 * The owner of a prompt raised with `parentToolUseId`, stated on its message. A team agent's prompts reach
 * the panel's handler with its agent id as `parentToolUseId`, a subagent's with its `Agent` call id;
 * anything else is the chat's own.
 */
export function promptOwnerOf(parentToolUseId: string | null | undefined, owners: PromptOwners): PromptOwner {
  if (!parentToolUseId) return { kind: 'main' };
  const member = owners.teamMember(parentToolUseId);
  if (member) {
    const teamTitle = oneLine(member.teamTitle, AGENT_NAME_MAX_CHARS);
    const agentName = agentLabel(member.agentName);
    return { kind: 'team', teamId: member.teamId, agentId: parentToolUseId, ...(teamTitle ? { teamTitle } : {}), ...(agentName ? { agentName } : {}) };
  }
  const agentId = owners.subagentOfToolCall(parentToolUseId);
  return agentId !== undefined ? { kind: 'subagent', agentId } : { kind: 'main' };
}

/** The file relative to the chat folder when it lies inside it, else as an absolute path. */
function displayPath(filePath: string, cwd: string): string {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  const outside = !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? absolute : relative;
}

/** "+7 −2" from a unified diff, or undefined when it changes no line. */
function patchCounts(patch: string): string | undefined {
  let added = 0;
  let removed = 0;
  for (const file of parsePatch(patch)) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
  }
  const parts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function lineCount(content: string): number {
  if (!content) return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

type PermissionRequest = Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>;

/** What an approval asks, or undefined when the file or command it acts on is missing. */
function approvalSummary(request: PermissionRequest, cwd: string): string | undefined {
  const input = request.toolInput;
  const file = request.filePath?.trim() ? displayPath(request.filePath, cwd) : undefined;
  if (request.toolName === TOOL_EDIT || request.toolName === TOOL_WRITE) {
    if (file === undefined) return undefined;
    const content = input['content'];
    if (request.toolName === TOOL_WRITE && request.patch === undefined && request.patchOmitted === undefined) {
      return t('create {0} ({1})', file, `+${lineCount(typeof content === 'string' ? content : '')}`);
    }
    const counts = request.patch !== undefined ? patchCounts(request.patch) : undefined;
    return counts ? t('edit {0} ({1})', file, counts) : t('edit {0}', file);
  }
  if (isShellTool(request.toolName)) {
    const command = request.command ?? (typeof input['command'] === 'string' ? input['command'] : '');
    const firstLine = command.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
    return firstLine === undefined ? undefined : t('run `{0}`', firstLine);
  }
  if (request.toolName === TOOL_GENERATE_IMAGE) return file === undefined ? undefined : t('generate image {0}', file);
  return t('use {0}', request.toolName);
}

/** One line naming what the prompt asks, or undefined when it names nothing (a plan, an untitled form). */
function summaryOf(request: ExtensionToWebviewMessage, cwd: string): string | undefined {
  switch (request.type) {
    case 'requestPermission': {
      const summary = approvalSummary(request, cwd);
      return summary === undefined ? undefined : oneLine(summary, PROMPT_SUMMARY_MAX_CHARS);
    }
    case 'requestSkillApproval':
      return oneLine(t('use skill {0}', request.skillName), PROMPT_SUMMARY_MAX_CHARS);
    case 'requestQuestion':
      return oneLine(request.questions[0]?.question ?? '', PROMPT_SUMMARY_MAX_CHARS);
    case 'requestForm':
      return oneLine(request.form.title ?? '', PROMPT_SUMMARY_MAX_CHARS);
    case 'requestElicitation':
      return oneLine(request.message, PROMPT_SUMMARY_MAX_CHARS);
    case 'extensionUiRequest':
      return oneLine(request.title, PROMPT_SUMMARY_MAX_CHARS);
    default:
      return undefined;
  }
}

/** A host dialog carries its own attribution; a permission prompt states its owner; an MCP elicitation names no agent. */
function ownerOf(request: ExtensionToWebviewMessage): PromptOwner {
  if (request.type === 'extensionUiRequest') {
    const agentName = request.agentName !== undefined ? agentLabel(request.agentName) : undefined;
    if (request.teamId !== undefined && request.agentId !== undefined) return { kind: 'team', teamId: request.teamId, agentId: request.agentId, ...(agentName ? { agentName } : {}) };
    return request.agentId !== undefined ? { kind: 'subagent', agentId: request.agentId } : { kind: 'main' };
  }
  return 'owner' in request ? request.owner : { kind: 'main' };
}

/** Each raised prompt with its owner, as the session state names them to the webview. */
export function pendingPromptOwners(raised: readonly RaisedPrompt[]): PendingPromptOwner[] {
  return raised.map(({ id, request }) => ({ id, owner: ownerOf(request) }));
}

/** The prompt's summary, or none when building it throws: a display-only summary must never break the state publisher. */
function guardedSummaryOf(id: string, request: ExtensionToWebviewMessage, cwd: string): string | undefined {
  try {
    return summaryOf(request, cwd);
  } catch (err) {
    // Only the error's name: its message can quote the prompt (jsdiff names the patch line it rejects).
    log('[pending-prompts] no summary for %s %s: %s', request.type, id, err instanceof Error ? err.name : typeof err);
    return undefined;
  }
}

/**
 * Describes the raised prompts: each with the agent that raised it and a one-line summary for a
 * notification. The summaries hold file paths, commands and model text, so they are never logged. A
 * prompt's message never changes while it is pending, so each is summarized once and its entry is
 * dropped on the first call it is no longer raised in.
 */
export function pendingPromptDescriber(cwd: string): (raised: readonly RaisedPrompt[]) => PendingPrompt[] {
  const summaries = new Map<string, { readonly request: ExtensionToWebviewMessage; readonly summary: string | undefined }>();
  return (raised) => {
    const live = new Set(raised.map((prompt) => prompt.id));
    for (const id of summaries.keys()) if (!live.has(id)) summaries.delete(id);
    return raised.map(({ id, kind, request }) => {
      let cached = summaries.get(id);
      if (cached?.request !== request) {
        cached = { request, summary: guardedSummaryOf(id, request, cwd) };
        summaries.set(id, cached);
      }
      const { summary } = cached;
      return { id, kind, owner: ownerOf(request), ...(summary !== undefined ? { summary } : {}) };
    });
  };
}
