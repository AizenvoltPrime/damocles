import type { NotificationService } from '../platform/notification-service';
import { t } from './l10n';
import { log } from './logger';

export type SharedStore =
  | { kind: 'memory' }
  | { kind: 'memoryInjection' }
  | { kind: 'usage'; dbPath: string }
  | { kind: 'compass'; folder: string };

const noticed = new Set<string>();

function storeName(store: SharedStore): string {
  switch (store.kind) {
    case 'memory':
      return t('the memory database');
    case 'memoryInjection':
      return t('the memory injection records');
    case 'usage':
      return t('the usage index');
    case 'compass':
      return t('the Compass index of {0}', store.folder);
  }
}

/** One notice per store: a Compass index per folder and the usage index per file. */
function noticeKey(store: SharedStore): string {
  switch (store.kind) {
    case 'compass':
      return `compass:${store.folder}`;
    case 'usage':
      return `usage:${store.dbPath}`;
    default:
      return store.kind;
  }
}

/**
 * Tell the user, once per store per session, that another Damocles app migrated a shared store past
 * this build's schema, so this window has it read only. See docs/invariants.md "Platform boundary and shared stores".
 */
export function notifySchemaAhead(notifications: NotificationService, store: SharedStore): void {
  const key = noticeKey(store);
  if (noticed.has(key)) return;
  noticed.add(key);
  log(`[SchemaSkew] ${key} was updated by a newer Damocles; read only from now on`);
  notifications
    .warn(t('Another Damocles app has updated {0} to a newer version. This window can read it but will not save changes to it until you update this Damocles too.', storeName(store)))
    .catch((err: unknown) => log(`[SchemaSkew] Could not show the read-only notice: ${err instanceof Error ? err.message : String(err)}`));
}
