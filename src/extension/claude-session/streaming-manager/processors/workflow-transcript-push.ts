import { log } from '../../../logger';
import { readWorkflowTranscripts } from '../../workflow-transcripts';
import type { ProcessorContext } from '../types';

const THROTTLE_MS = 1500;

/**
 * Read a running workflow's per-agent transcripts from disk and push them to the webview.
 *
 * The extension owns the live SDK event stream, so it drives transcript updates rather than
 * relying on the panel to poll: agent cards appear (running, then completed) as the run
 * progresses whether or not the overlay is open. Progress-driven calls are throttled to one
 * disk read per workflow per {@link THROTTLE_MS}; the completion call passes `force` to flush
 * the final state immediately. Resolution of the transcript directory is captured at launch
 * (see `captureWorkflowLaunchBinding`).
 */
export function pushWorkflowTranscripts(ctx: ProcessorContext, toolUseId: string, force: boolean): void {
  const dir = ctx.state.workflowTranscriptDirs.get(toolUseId);
  if (!dir) return;

  if (!force) {
    const now = Date.now();
    const last = ctx.state.workflowTranscriptLastPush.get(toolUseId) ?? 0;
    if (now - last < THROTTLE_MS) return;
    ctx.state.workflowTranscriptLastPush.set(toolUseId, now);
  }

  const seq = ctx.state.nextWorkflowTranscriptSeq(toolUseId);
  void readWorkflowTranscripts(dir)
    .then(agents => {
      // The disk read suspends; a session switch clears the binding (resetStreaming) in between.
      // Drop the push if this workflow is no longer tracked so a stale read can't seed a phantom
      // run in the next session's panel.
      if (!ctx.state.workflowTranscriptDirs.has(toolUseId)) return;
      ctx.deps.callbacks.onMessage({ type: 'workflowTranscripts', toolUseId, agents, seq });
    })
    .catch(err => {
      log('[StreamingManager] Failed to push workflow transcripts: %s', err instanceof Error ? err.message : String(err));
    });
}
