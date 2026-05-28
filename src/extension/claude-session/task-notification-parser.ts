import type { WorkflowStatus, WorkflowUsage } from '../../shared/types/workflows';

export interface ParsedTaskNotification {
  taskId: string;
  toolUseId: string;
  result: string;
  summary: string;
  status: WorkflowStatus;
  outputFile: string | null;
  usage: WorkflowUsage | null;
}

function normalizeStatus(value: string | undefined): WorkflowStatus {
  if (value === 'failed' || value === 'stopped' || value === 'running') return value;
  return 'completed';
}

function parseUsage(content: string): WorkflowUsage | null {
  const block = content.match(/<usage>([\s\S]*?)<\/usage>/)?.[1];
  if (!block) return null;
  const num = (tag: string): number => {
    const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return match?.[1] ? Number(match[1].trim()) || 0 : 0;
  };
  return {
    agentCount: num('agent_count'),
    subagentTokens: num('subagent_tokens'),
    toolUses: num('tool_uses'),
    durationMs: num('duration_ms'),
  };
}

/**
 * Parse a `<task-notification>` body. Returns null for bodies missing the
 * task-id/tool-use-id pair (e.g. monitor events), letting callers fall through.
 */
export function parseTaskNotification(content: string): ParsedTaskNotification | null {
  const taskId = content.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1];
  const toolUseId = content.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/)?.[1];
  if (!taskId || !toolUseId) return null;

  return {
    taskId: taskId.trim(),
    toolUseId: toolUseId.trim(),
    result: content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? '',
    summary: content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? '',
    status: normalizeStatus(content.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim()),
    outputFile: content.match(/<output-file>([\s\S]*?)<\/output-file>/)?.[1]?.trim() ?? null,
    usage: parseUsage(content),
  };
}
