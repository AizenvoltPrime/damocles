import type { NotificationService } from '../platform/notification-service';
import type { SecretsStore } from '../platform/secrets-store';
import type { ShellService } from '../platform/shell-service';
import { t } from './l10n';

// README section "Desktop credential storage"; keep the anchor equal to that heading.
export const CREDENTIAL_STORAGE_HELP_URL = 'https://github.com/AizenvoltPrime/damocles#desktop-credential-storage';

/**
 * A store that tells the user, once per run and on the first secret saved, that secrets last only until a
 * restart when the host keeps them in memory; a persistent store is returned unchanged.
 */
export function withVolatileSecretsNotice(secrets: SecretsStore, notifications: NotificationService, shell: ShellService): SecretsStore {
  if (secrets.isPersistent) return secrets;
  let noticed = false;
  return {
    isPersistent: false,
    get: (key) => secrets.get(key),
    keys: () => secrets.keys(),
    delete: (key) => secrets.delete(key),
    store: async (key, value) => {
      await secrets.store(key, value);
      if (noticed) return;
      noticed = true;
      const howTo = t('How to Turn It On');
      // Not awaited: the notice resolves only when the user answers it, and the store must not wait for that.
      void notifications.warn(
        t('Damocles cannot reach your operating system\'s keyring, so the key or sign-in you just saved lasts only until Damocles restarts. Turn on the keyring to keep it.'),
        howTo,
      ).then((choice) => {
        if (choice === howTo) void shell.openExternal(CREDENTIAL_STORAGE_HELP_URL);
      });
    },
  };
}
