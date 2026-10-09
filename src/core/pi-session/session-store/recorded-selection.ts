import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export interface RecordedSelection {
  readonly model: { readonly provider: string; readonly modelId: string } | undefined;
  readonly thinkingLevel: string | undefined;
}

/**
 * The model and thinking level a session's branch last recorded, which pi resumes on (sdk.js createAgentSession): the latest
 * model change or assistant reply, and the latest thinking level change. Undefined for a branch with no message, which pi
 * starts on its defaults. A session file is untrusted input, so a malformed entry is skipped.
 */
export function recordedSelection(branch: readonly SessionEntry[]): RecordedSelection | undefined {
  let continuing = false;
  let model: RecordedSelection['model'];
  let thinkingLevel: string | undefined;
  for (const entry of branch) {
    const raw = entry as { type?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown; message?: { role?: unknown; provider?: unknown; model?: unknown } };
    if (raw.type === 'model_change' && typeof raw.provider === 'string' && typeof raw.modelId === 'string') model = { provider: raw.provider, modelId: raw.modelId };
    if (raw.type === 'thinking_level_change' && typeof raw.thinkingLevel === 'string') thinkingLevel = raw.thinkingLevel;
    if (raw.type !== 'message') continue;
    continuing = true;
    const message = raw.message;
    if (message?.role === 'assistant' && typeof message.provider === 'string' && typeof message.model === 'string') model = { provider: message.provider, modelId: message.model };
  }
  return continuing ? { model, thinkingLevel } : undefined;
}
