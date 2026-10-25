// A daemon's core: Claude requests bill as the client that sends them chose. Each request is shaped by the subscription
// plugin the server package bundles only while its pinned (else acting) client bills its Claude sign-in to the allowance;
// every other request goes through pi's own Anthropic transport. Nothing here reads or writes the host's pi settings.
import * as path from 'node:path';
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';
import type { RemoteHost } from '../../platform/remote-host';
import { currentPin } from '../client-snapshots';
import { log } from '../logger';
import type { PiCodingAgentModule } from './pi-loader';
import type { ClaudeAuthStatus } from './subscription';

export type AnthropicStreamSimple = NonNullable<ProviderConfig['streamSimple']>;

/** Where a package's core finds the bundled plugin: `dist/subscription-plugin` (PLUGIN_DIR in scripts/subscription-plugin.mjs). */
export function subscriptionPluginDir(resourceRoot: string): string {
  return path.join(resourceRoot, 'dist', 'subscription-plugin');
}

/** The pinned (else acting) client's Claude sign-in, from its clientAuth; never a token. */
function clientAnthropic(remote: RemoteHost) {
  const clientId = currentPin(remote).clientId;
  return clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers['anthropic'];
}

/** Whether the pinned (else acting) client bills its Claude OAuth sign-in to the subscription's allowance. */
export function clientBillsAllowance(remote: RemoteHost): boolean {
  const entry = clientAnthropic(remote);
  return entry?.type === 'oauth' && entry.allowance === true;
}

/** The Claude mode of the pinned (else acting) client on this host: its credential and choice, and whether the plugin loaded here. */
export function clientClaudeAuthStatus(remote: RemoteHost, pluginLoaded: boolean): ClaudeAuthStatus {
  const entry = clientAnthropic(remote);
  if (entry?.type === 'api_key') return { mode: 'apikey' };
  if (entry?.type !== 'oauth') return { mode: 'none' };
  if (entry.allowance !== true) return { mode: 'extra' };
  return pluginLoaded ? { mode: 'allowance' } : { mode: 'extra', allowanceUnavailable: true };
}

/**
 * The plugin's shaped transport, captured from its `anthropic` registration and never registered itself; undefined, with
 * the reason logged, when it does not load. Its folder is both cwd and agent dir, and holds no extensions folder, so pi
 * discovers nothing else there.
 */
export async function loadAllowanceTransport(pi: PiCodingAgentModule, dir: string): Promise<AnthropicStreamSimple | undefined> {
  const loaded = await pi.discoverAndLoadExtensions([dir], dir, dir).catch((err: unknown) => {
    log('[allowance] loading the bundled subscription plugin from %s threw: %O', dir, err);
    return undefined;
  });
  if (!loaded) return undefined;
  for (const { path: extensionPath, error } of loaded.errors) log('[allowance] the bundled subscription plugin failed to load (%s): %s', extensionPath, error);
  const shaped = loaded.runtime.pendingProviderRegistrations.find((registration) => registration.name === 'anthropic')?.config.streamSimple;
  if (!shaped) log('[allowance] the bundled subscription plugin at %s gave no anthropic transport, so allowance sign-ins bill extra usage here', dir);
  return loaded.errors.length === 0 ? shaped : undefined;
}

/** pi's own Anthropic transport, the one the plugin wraps and pi uses with no `anthropic` registration. */
export async function builtinAnthropicTransport(): Promise<AnthropicStreamSimple> {
  const { anthropicMessagesApi } = await import('@earendil-works/pi-ai/api/anthropic-messages.lazy');
  return anthropicMessagesApi().streamSimple;
}

/** pi's `anthropic` provider on a daemon's core: each request picks its transport by the client it runs for. */
export function allowanceProvider(remote: RemoteHost, builtin: AnthropicStreamSimple, shaped: AnthropicStreamSimple | undefined): ProviderConfig {
  return {
    api: 'anthropic-messages',
    streamSimple: (model, context, options) => (shaped && clientBillsAllowance(remote) ? shaped : builtin)(model, context, options),
  };
}
