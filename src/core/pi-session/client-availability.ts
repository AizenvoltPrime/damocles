import type { Api, CredentialStore, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { RemoteHost } from '../../platform/remote-host';
import type { HeldAuthEntry } from '../../shared/remote-user';
import { credentialOwner, outsidePins, runPin } from '../client-snapshots';
import { clientNotConnected, clientPendingError, statusCredentialOf } from './credential-broker';

type AvailabilityReads = Pick<ModelRuntime, 'getProviders' | 'getProvider' | 'getAvailableSnapshot' | 'getAvailable' | 'checkAuth' | 'isUsingOAuth' | 'getProviderAuthStatus' | 'hasConfiguredAuth'>;

/**
 * A daemon's core: replaces pi's availability reads on `modelRuntime`, whose snapshot holds only the host's own credentials,
 * with ones that add the pinned (else acting) client's from its clientAuth, and under a pin that names no device, or whose
 * device's sign-ins or user rules are not known yet, report none and never the host's own; checkAuth refuses as the broker
 * does, and inside a run waits on `credentials` (the broker) until those are known; returns the host's own check.
 */
export function installClientAvailability(modelRuntime: AvailabilityReads, remote: RemoteHost, credentials: Pick<CredentialStore, 'read'>): (provider: string) => boolean {
  const hostHasAuth = modelRuntime.hasConfiguredAuth.bind(modelRuntime);
  const hostUsesOAuth = modelRuntime.isUsingOAuth.bind(modelRuntime);
  const hostAuthStatus = modelRuntime.getProviderAuthStatus.bind(modelRuntime);
  const hostSnapshot = modelRuntime.getAvailableSnapshot.bind(modelRuntime);
  const hostAvailable = modelRuntime.getAvailable.bind(modelRuntime);
  const hostCheckAuth = modelRuntime.checkAuth.bind(modelRuntime);

  // a credential the client holds owns its provider, so the host's own for that provider is not consulted (pi-ai auth/resolve.js)
  const ownerOf = (providerId: string) => credentialOwner(remote, providerId);
  // pi-ai resolves a stored credential only through the provider's handler of its type
  const accepts = (providerId: string, entry: HeldAuthEntry): boolean => {
    const auth = modelRuntime.getProvider(providerId)?.auth;
    return (entry.type === 'oauth' ? auth?.oauth : auth?.apiKey) !== undefined;
  };
  const composed = (hostModels: readonly Model<Api>[]): Model<Api>[] => {
    const hostByProvider = new Map<string, Model<Api>[]>();
    for (const model of hostModels) {
      const models = hostByProvider.get(model.provider);
      if (models) models.push(model);
      else hostByProvider.set(model.provider, [model]);
    }
    return modelRuntime.getProviders().flatMap((provider) => {
      const owner = ownerOf(provider.id);
      if (owner.kind === 'noDevice' || owner.kind === 'pending') return [];
      if (owner.kind === 'host') return hostByProvider.get(provider.id) ?? [];
      if (!accepts(provider.id, owner.entry)) return [];
      const models = provider.getModels();
      return [...(provider.filterModels?.(models, statusCredentialOf(owner.entry)) ?? models)];
    });
  };

  modelRuntime.hasConfiguredAuth = (providerId) => {
    const owner = ownerOf(providerId);
    if (owner.kind === 'noDevice' || owner.kind === 'pending') return false;
    return owner.kind === 'client' ? accepts(providerId, owner.entry) : hostHasAuth(providerId);
  };
  modelRuntime.isUsingOAuth = (providerId) => {
    const owner = ownerOf(providerId);
    if (owner.kind === 'noDevice' || owner.kind === 'pending') return false;
    return owner.kind === 'client' ? owner.entry.type === 'oauth' && accepts(providerId, owner.entry) : hostUsesOAuth(providerId);
  };
  // pi's order: a runtime key, then a stored credential, then config and environment
  modelRuntime.getProviderAuthStatus = (providerId) => {
    const status = hostAuthStatus(providerId);
    if (status.source === 'runtime') return status;
    const owner = ownerOf(providerId);
    if (owner.kind === 'noDevice' || owner.kind === 'pending') return { configured: false };
    return owner.kind === 'client' ? { configured: true, source: 'stored' } : status;
  };
  // pi's own check reads the broker, which answers none outside a pin and asks the client inside one
  modelRuntime.checkAuth = async (providerId, options) => {
    options?.signal?.throwIfAborted();
    const owner = ownerOf(providerId);
    // pi's preflight and setModel then fail with the broker's own reason, not a missing key
    if (owner.kind === 'noDevice') throw clientNotConnected(providerId);
    if (owner.kind === 'pending') {
      // the broker decides: a turn waits behind Sign-in needed with the reason, a sub-call fails; then judged as known
      if (runPin() === undefined) throw clientPendingError(providerId, owner.reason);
      await credentials.read(providerId, options);
      return modelRuntime.checkAuth(providerId, options);
    }
    if (owner.kind === 'host') return outsidePins(() => hostCheckAuth(providerId, options));
    if (!accepts(providerId, owner.entry)) return undefined;
    return owner.entry.type === 'oauth' ? { source: 'OAuth', type: 'oauth' } : { source: 'stored credential', type: 'api_key' };
  };
  modelRuntime.getAvailableSnapshot = () => composed(hostSnapshot());
  // pi's pass runs in its caller's context, and inside a pin its reads would ask that client for real credentials
  modelRuntime.getAvailable = async (providerId, options) => {
    const models = composed(await outsidePins(() => hostAvailable(providerId, options)));
    return providerId === undefined ? models : models.filter((model) => model.provider === providerId);
  };
  return hostHasAuth;
}
