import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { RemoteHost } from '../../platform/remote-host';
import type { SecretsStore } from '../../platform/secrets-store';
import { currentPin } from '../client-snapshots';
import { describeAuthError, isCredentialSyncError } from './describe-error';
import { log } from '../logger';
import {
  OPENAI_API_KEY_SECRET,
  OPENAI_API_PROVIDER,
  openaiRuntimeKeyWanted,
  readOpenAIAuthFromDisk,
} from './openai-auth';

export interface OpenAIRuntimeKeyDeps {
  modelRuntime: Pick<ModelRuntime, 'setRuntimeApiKey' | 'removeRuntimeApiKey'>;
  secrets: Pick<SecretsStore, 'get'>;
  agentDir: string;
  preferApiKey: boolean;
  /** Receives whether the secret is present, before pi is called, so a pi failure cannot leave it stale. */
  onKeyPresence: (present: boolean) => void;
  /** A daemon's core: the key is the pinned client's, served by the broker, so presence comes from its clientAuth. */
  remote?: RemoteHost;
}

/**
 * Apply the key secret as pi's `openai` runtime key when the rule wants it, else drop the runtime key.
 * Reads the secret and auth.json on every call and keeps no applied-key cache, because pi's logout drops
 * the runtime key behind its back. Never logs out: that would delete a ChatGPT grant. pi's
 * `CredentialSynchronizationError` comes after it committed the change, so it counts as applied.
 */
export async function syncOpenAIRuntimeKey(deps: OpenAIRuntimeKeyDeps): Promise<void> {
  // pi reads its runtime keys before any credential store, so one there would serve every client's turns
  if (deps.remote) {
    const clientId = currentPin(deps.remote).clientId;
    deps.onKeyPresence(clientId !== undefined && deps.remote.clients.auth(clientId)?.providers[OPENAI_API_PROVIDER]?.hasKey === true);
    return;
  }
  const key = await deps.secrets.get(OPENAI_API_KEY_SECRET);
  const apiKey = key !== undefined && key !== '';
  deps.onKeyPresence(apiKey);
  const { chatgpt } = readOpenAIAuthFromDisk(deps.agentDir);
  try {
    if (apiKey && openaiRuntimeKeyWanted({ apiKey, chatgpt }, deps.preferApiKey)) {
      await deps.modelRuntime.setRuntimeApiKey(OPENAI_API_PROVIDER, key);
    } else {
      await deps.modelRuntime.removeRuntimeApiKey(OPENAI_API_PROVIDER);
    }
  } catch (err) {
    if (!isCredentialSyncError(err)) throw err;
    log('[openai-runtime-key] the runtime key change is applied, but pi could not resynchronize its model snapshot: %s', describeAuthError(err));
  }
}
