// Remembered ssh passwords and passphrases (D9 layer 3), each bound to the hop it answers: the host, port and user `ssh -G`
// reported for it, and for a passphrase the key file. They live only in SecretsStore, under the saved host's id.
import { createHash } from 'node:crypto';
import type { SecretsStore } from '../../../../platform/secrets-store';
import { HOST_ID } from '../../../daemon/control-messages';

export interface HopIdentity {
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
}

export type RememberedTarget = { readonly hop: HopIdentity; readonly kind: 'password' } | { readonly hop: HopIdentity; readonly kind: 'passphrase'; readonly identityFile: string };

// a saved host's id holds no '.', so one host's prefix never covers another's keys
const prefixOf = (hostId: string): string => {
  if (!HOST_ID.test(hostId)) throw new RangeError('a host id remembered secrets cannot be keyed by');
  return `damocles.remote.ssh.${hostId}.`;
};

/** damocles.remote.ssh.<hostId>.<sha256(host, port, user[, key file])>.<kind> */
export function rememberedSecretKey(hostId: string, target: RememberedTarget): string {
  const { hostname, port, user } = target.hop;
  const identity = target.kind === 'passphrase' ? [hostname, port, user, target.identityFile] : [hostname, port, user];
  return `${prefixOf(hostId)}${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}.${target.kind}`;
}

// One host's remembered answers as one attempt sees them, bound when the attempt began.
export interface HostSecrets {
  get(target: RememberedTarget): Promise<string | undefined>;
  // false, storing nothing, when the host's answers were all deleted since the attempt began
  store(target: RememberedTarget, value: string): Promise<boolean>;
  delete(target: RememberedTarget): Promise<void>;
}

export interface RememberedSecrets {
  forHost(hostId: string): HostSecrets;
  /** Deletes every remembered answer of the host: Forget host, and its Remember password switched off. */
  deleteAllForHost(hostId: string): Promise<void>;
}

/** One per process: a host's reads, stores and deletes run in order, so a store never lands after its host's deletion. */
export function createRememberedSecrets(secrets: SecretsStore): RememberedSecrets {
  const queues = new Map<string, Promise<unknown>>();
  // bumped by every deleteAllForHost, so an attempt that began before it stores nothing
  const generations = new Map<string, number>();
  const queued = <T>(hostId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(hostId) ?? Promise.resolve()).then(work);
    queues.set(hostId, run.catch(() => undefined));
    return run;
  };
  return {
    forHost(hostId) {
      const generation = generations.get(hostId) ?? 0;
      return {
        get: async (target) => queued(hostId, () => secrets.get(rememberedSecretKey(hostId, target))),
        store: async (target, value) => queued(hostId, async () => {
          if ((generations.get(hostId) ?? 0) !== generation) return false;
          await secrets.store(rememberedSecretKey(hostId, target), value);
          return true;
        }),
        delete: async (target) => queued(hostId, () => secrets.delete(rememberedSecretKey(hostId, target))),
      };
    },
    async deleteAllForHost(hostId) {
      const prefix = prefixOf(hostId);
      generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
      await queued(hostId, async () => {
        for (const key of await secrets.keys()) if (key.startsWith(prefix)) await secrets.delete(key);
      });
    },
  };
}
