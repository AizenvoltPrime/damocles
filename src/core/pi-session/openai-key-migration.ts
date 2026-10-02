import * as fs from 'fs';
import * as path from 'path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthResult } from '@earendil-works/pi-ai';
import type { Memento } from '../../platform/key-value-state';
import type { NotificationService } from '../../platform/notification-service';
import type { SecretsStore } from '../../platform/secrets-store';
import { writeFileAtomic } from './checkpoints/atomic-write';
import { OPENAI_API_KEY_SECRET, OPENAI_API_PROVIDER, readOpenAIAuthFromDisk } from './openai-auth';
import { t } from '../l10n';
import { log } from '../logger';

export type AppHost = 'vscode' | 'desktop';

/** Global-state key: this app already showed the "key moved to the other app" notice. */
export const OPENAI_KEY_MOVED_NOTICE_SHOWN_STATE = 'damocles.openai.keyMovedNoticeShown';

export interface OpenAIKeyMigrationDeps {
  modelRuntime: { getAuth(providerId: string): Promise<AuthResult | undefined> } & Pick<ModelRuntime, 'logout'>;
  secrets: Pick<SecretsStore, 'get' | 'store' | 'isPersistent'>;
  agentDir: string;
  markerPath: string;
  host: AppHost;
}

/**
 * Move a plain-text auth.json `openai` api_key into this app's secret store, then delete the auth.json copy.
 * A different key already in the secret store wins. Deletes only after the secret reads back, and only
 * while auth.json still holds an api_key there, so a ChatGPT grant is never removed. Returns whether it moved.
 * A store that is not persistent gets nothing: the key stays in auth.json, where pi uses it, until a start
 * with a persistent store. Callers run it before any OpenAI sign-in in this process can start: pi has no
 * compare-and-delete.
 */
export async function migrateOpenAIApiKey(deps: OpenAIKeyMigrationDeps): Promise<boolean> {
  if (!readOpenAIAuthFromDisk(deps.agentDir).storedApiKey) return false;
  if (!deps.secrets.isPersistent) {
    log('[OpenAIKeyMigration] the secret store is not persistent; the OpenAI API key stays in auth.json until a start with a persistent one');
    return false;
  }
  const existing = await deps.secrets.get(OPENAI_API_KEY_SECRET);
  if (existing === undefined || existing === '') {
    const resolved = await deps.modelRuntime.getAuth(OPENAI_API_PROVIDER);
    // pi falls through to an ambient OPENAI_API_KEY when the stored entry has no key, which must not be copied.
    const key = resolved?.source === 'stored credential' ? resolved.auth.apiKey : undefined;
    if (!key) throw new Error('auth.json holds an OpenAI api_key that resolves to no stored key');
    await deps.secrets.store(OPENAI_API_KEY_SECRET, key);
    if ((await deps.secrets.get(OPENAI_API_KEY_SECRET)) !== key) {
      throw new Error('the OpenAI API key did not read back from the secret store');
    }
  } else {
    const resolved = await deps.modelRuntime.getAuth(OPENAI_API_PROVIDER);
    const same = resolved?.source === 'stored credential' && resolved.auth.apiKey === existing;
    log(
      same
        ? '[OpenAIKeyMigration] the secret store already holds the same API key as auth.json'
        : '[OpenAIKeyMigration] the secret store holds a different API key, which wins; the auth.json key is discarded',
    );
  }
  if (!readOpenAIAuthFromDisk(deps.agentDir).storedApiKey) return false;
  // Before the delete: the other app's notice also requires auth.json to hold no key, so an early marker shows nothing.
  await fs.promises.mkdir(path.dirname(deps.markerPath), { recursive: true });
  await writeFileAtomic(deps.markerPath, `${JSON.stringify({ movedAt: Date.now(), by: deps.host })}\n`);
  await deps.modelRuntime.logout(OPENAI_API_PROVIDER);
  log('[OpenAIKeyMigration] moved the OpenAI API key from auth.json to the %s secret store', deps.host);
  return true;
}

/** The host named by the marker; undefined when there is no marker. */
function readMarkerHost(markerPath: string): AppHost | undefined {
  let text: string;
  try {
    text = fs.readFileSync(markerPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const by: unknown = (JSON.parse(text) as { by?: unknown } | null)?.by;
  if (by !== 'vscode' && by !== 'desktop') throw new Error(`${markerPath} names no host`);
  return by;
}

export interface OpenAIKeyMovedNoticeDeps {
  secrets: Pick<SecretsStore, 'get'>;
  state: Memento;
  notifications: Pick<NotificationService, 'info'>;
  agentDir: string;
  markerPath: string;
  host: AppHost;
  openAuthPanel: () => void;
}

/**
 * Once per app: when the other host moved the key into its own secret store and this app has none, ask the
 * user to enter it here. Resolves after the notice is answered, or at once when none is due.
 */
export async function showOpenAIKeyMovedNotice(deps: OpenAIKeyMovedNoticeDeps): Promise<void> {
  // Memento has no compare-and-set, so two windows activating together can both show it; that duplicate is accepted.
  if (deps.state.get<boolean>(OPENAI_KEY_MOVED_NOTICE_SHOWN_STATE, false)) return;
  const by = readMarkerHost(deps.markerPath);
  if (by === undefined || by === deps.host) return;
  if (readOpenAIAuthFromDisk(deps.agentDir).storedApiKey) return;
  const own = await deps.secrets.get(OPENAI_API_KEY_SECRET);
  if (own !== undefined && own !== '') return;
  await deps.state.update(OPENAI_KEY_MOVED_NOTICE_SHOWN_STATE, true);
  const action = t('Open OpenAI Sign-in');
  const choice = await deps.notifications.info(
    t("Your OpenAI API key moved to the other Damocles app's keychain. Enter it here once."),
    action,
  );
  if (choice === action) deps.openAuthPanel();
}
