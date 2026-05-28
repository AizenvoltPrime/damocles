/**
 * Single source for parsing the `Workflow` tool's human-readable launch result
 * (e.g. "Workflow launched in background. Task ID: <id> … Transcript dir: <path>").
 *
 * The SDK exposes no structured field for the task id or transcript directory on
 * `system:task_started`, so this text is the only source. Both the extension
 * (live binding) and the webview (card meta) parse it — keeping the regexes here
 * means a wording change is fixed in exactly one place rather than drifting.
 */
export interface WorkflowLaunchInfo {
  taskId: string | null;
  transcriptDir: string | null;
}

export function parseWorkflowLaunch(result: string): WorkflowLaunchInfo {
  return {
    taskId: result.match(/Task ID:\s*(\S+)/)?.[1]?.trim() ?? null,
    transcriptDir: result.match(/Transcript dir:\s*(.+)/)?.[1]?.trim() ?? null,
  };
}
