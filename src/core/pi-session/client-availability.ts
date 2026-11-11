import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { RemoteHost } from '../../platform/remote-host';
import type { HeldAuthEntry } from '../../shared/remote-user';
import { currentPin, entryHoldsCredential, outsidePins } from '../client-snapshots';
import { statusCredentialOf } from './credential-broker';

type AvailabilityReads = Pick<ModelRuntime, 'getProviders' | 'getProvider' | 'getAvailableSnapshot' | 'getAvailable' | 'isUsingOAuth' | 'getProviderAuthStatus' | 'hasConfiguredAuth'>;

/**
 * A daemon's core: replaces pi's availability reads on `modelRuntime`, whose snapshot holds only the host's own credentials,
 * with ones that add the pinned (else acting) client's from its clientAuth; returns the host's own check.
 */
export function installClientAvailability(modelRuntime: AvailabilityReads, remote: RemoteHost): (provider: string) => boolean {
  const hostHasAuth = modelRuntime.hasConfiguredAuth.bind(modelRuntime);
  const hostUsesOAuth = modelRuntime.isUsingOAuth.bind(modelRuntime);
  const hostAuthStatus = modelRuntime.getProviderAuthStatus.bind(modelRuntime);
  const hostSnapshot = modelRuntime.getAvailableSnapshot.bind(modelRuntime);
  const hostAvailable = modelRuntime.getAvailable.bind(modelRuntime);

  // a credential the client holds owns its provider, so the host's own for that provider is not consulted (pi-ai auth/resolve.js)
  const held = (providerId: string): HeldAuthEntry | undefined => {
    const clientId = currentPin(remote).clientId;
    const entry = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers[providerId];
    return entryHoldsCredential(entry) ? entry : undefined;
  };
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
      const entry = held(provider.id);
      if (!entry) return hostByProvider.get(provider.id) ?? [];
      if (!accepts(provider.id, entry)) return [];
      const models = provider.getModels();
      return [...(provider.filterModels?.(models, statusCredentialOf(entry)) ?? models)];
    });
  };

  modelRuntime.hasConfiguredAuth = (providerId) => {
    const entry = held(providerId);
    return entry ? accepts(providerId, entry) : hostHasAuth(providerId);
  };
  modelRuntime.isUsingOAuth = (providerId) => {
    const entry = held(providerId);
    return entry ? entry.type === 'oauth' && accepts(providerId, entry) : hostUsesOAuth(providerId);
  };
  // pi's order: a runtime key, then a stored credential, then config and environment
  modelRuntime.getProviderAuthStatus = (providerId) => {
    const status = hostAuthStatus(providerId);
    if (status.source === 'runtime') return status;
    return held(providerId) ? { configured: true, source: 'stored' } : status;
  };
  modelRuntime.getAvailableSnapshot = () => composed(hostSnapshot());
  // pi's pass runs in its caller's context, and inside a pin its reads would ask that client for real credentials
  modelRuntime.getAvailable = async (providerId, options) => {
    const models = composed(await outsidePins(() => hostAvailable(providerId, options)));
    return providerId === undefined ? models : models.filter((model) => model.provider === providerId);
  };
  return hostHasAuth;
}
