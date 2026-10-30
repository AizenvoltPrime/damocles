import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { catalogEntryOfPiModel } from '../../../shared/model-vendor';

/**
 * The models that wrote the branch's replies before its latest switch to `currentModel`, oldest first, one per run of
 * consecutive replies: catalog values, or pi's model id for a model outside the catalog. Empty when no other model replied.
 * An errored or aborted reply is no run, since pi-ai never sends one to the next model. The list changes only at a switch:
 * a reply by `currentModel` extends the trailing run this drops. A session file is untrusted input, so a malformed entry
 * is skipped.
 */
export function earlierModelRuns(branch: readonly SessionEntry[], currentModel: string): string[] {
  const runs: string[] = [];
  for (const entry of branch) {
    const raw = entry as { type?: unknown; message?: { role?: unknown; provider?: unknown; model?: unknown; stopReason?: unknown } };
    const message = raw.type === 'message' ? raw.message : undefined;
    if (message?.role !== 'assistant' || typeof message.provider !== 'string' || typeof message.model !== 'string') continue;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    const key = catalogEntryOfPiModel(message.provider, message.model)?.value ?? message.model;
    if (runs.at(-1) !== key) runs.push(key);
  }
  if (runs.at(-1) === currentModel) runs.pop();
  return runs;
}
