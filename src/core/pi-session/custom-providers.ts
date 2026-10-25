/**
 * custom-providers.ts — Native multi-provider registration for subagents (Phase 5, US-018.8).
 *
 * Replaces the explore proxy's purpose with native pi providers (no loopback). Keys come from
 * SecretStorage entries and are applied to the live `ModelRuntime` as
 * in-memory runtime API keys (`setRuntimeApiKey`) — never `process.env`. StepFun is registered fresh
 * against its step-plan SUBSCRIPTION endpoint
 * (`api.stepfun.ai/step_plan`, Anthropic-shaped, Bearer auth, model `step-5-preview`); DeepSeek, MiniMax, xAI,
 * Kimi Code, Meta, OpenRouter and TypeSafe are existing pi providers that only need their key. GitHub Copilot has no key, only
 * pi's sign-in.
 *
 * This module owns the provider table and the cheap-model lookup (provider-matched Explore default, §4.9).
 *
 * SEMANTIC NOTE: custom-provider keys are NOT persisted into pi's `auth.json`. They are applied as
 * in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`) and re-synced from VS Code
 * SecretStorage on every session start and on secret change — so they live only for the process
 * lifetime and never leak into pi's on-disk credential store. A saved key is applied only while
 * `providerRuntimeKeyWanted` holds: a stored sign-in outranks it unless the provider's "Prefer API key"
 * flag is on. Otherwise the sync drops the runtime key it applied and never logs out, which would delete
 * the sign-in; only the one-time sweep logs out, of a stored `api_key` for the providers whose keys Damocles
 * 2.6 and earlier wrote into auth.json in plain text (`ProviderKeyDef.legacySweep`).
 *
 * pi 0.85 credential semantics: `setRuntimeApiKey` / `removeRuntimeApiKey` / `logout` serialize per
 * provider, and after committing the credential run an OFFLINE single-provider refresh plus an
 * availability probe that reads `auth.json` under a file lock — not 0.83's whole-runtime networked
 * refresh. All three honor `AuthOperationOptions.signal`, which truly cancels rather than orphaning an
 * operation still holding the lock; `deps.signal` threads that through.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Api, AuthOperationOptions } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';
import { writeFileAtomic } from './checkpoints/atomic-write';
import { providerRuntimeKeyWanted, readProviderSignIns } from './provider-auth';
import type { RemoteHost } from '../../platform/remote-host';
import { currentPin, outsidePins } from '../client-snapshots';
import { describeAuthError, isCredentialSyncError } from './describe-error';
import type { ModelLookup } from './pi-models';
import { PROVIDER_SECRET_KEYS } from './explore-providers';
import type { AccountProviderId, KeyProviderId, SignInProviderId } from '../../shared/settings-sections';
import { DEFAULT_MODELS } from '../../shared/types/constants';

/** pi's `registerProvider` config shape (`ProviderConfigInput` is not re-exported from the package root). */
type ProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1];

/** A provider with an Accounts row of its own: a key Damocles stores, a pi OAuth sign-in, or both. */
export interface CustomProviderDef {
  /** pi provider name. */
  provider: AccountProviderId;
  key?: ProviderKeyDef;
  /** pi's OAuth sign-in for the provider. */
  signIn?: ProviderSignInDef;
  /** The catalog value of the provider's designated cheap model: the Explore default of a chat on this provider, and one
   *  of Automatic's background candidates unless `pickedOnly` is set. */
  cheapModel?: string;
  /** Damocles never chooses this provider's models on its own: a new chat's fallback and Automatic skip them, and its
   *  cheap model serves only a chat the user already put on the provider. */
  pickedOnly?: true;
  /** The provider limits its models per account plan, and its stored sign-in lists them (`availableModelIds`). */
  plan?: boolean;
  /** Every credential bills a flat subscription, so none of its models bills dollars, in the catalog or not. Its catalog entries set `flatFee`. */
  flatFee?: true;
}

/** A key Damocles stores in the host secret store and applies to pi only in memory. */
export interface ProviderKeyDef {
  /** SecretStorage key holding the API key. */
  secretKey: string;
  /** Whether pi already ships this provider (only auth needed) or it must be registered fresh. */
  mode: 'register' | 'authenticate';
  /** Full `registerProvider` config for `mode: 'register'` providers (StepFun). */
  registerConfig?: ProviderConfigInput;
  /** Whether a key bills a flat subscription rather than per token. A pure prefix test that never logs,
   *  applied only to the key Damocles stored, never to an environment or `auth.json` credential. */
  flatFeeKey?: (key: string) => boolean;
  /** Damocles 2.6 and earlier also wrote this key into auth.json in plain text, which the one-time sweep logs out.
   *  Only those providers: a stored `api_key` of any other is the user's own. */
  legacySweep?: true;
}

/** A def of a key provider, whose key def is always set. */
export type KeyedProviderDef = CustomProviderDef & { readonly provider: KeyProviderId; readonly key: ProviderKeyDef };

/** A provider's pi OAuth sign-in. `textPrompt` names what pi's `text` prompt asks for; a provider without one gets no text prompt answered. */
export interface ProviderSignInDef {
  textPrompt?: 'enterpriseDomain';
}

// Exactly the KEY_PROVIDER_IDS providers have a key def, and exactly the SIGN_IN_PROVIDER_IDS ones a sign-in def.
type AccountProviderDefOf<P extends AccountProviderId> = CustomProviderDef & { readonly provider: P }
  & (P extends KeyProviderId ? { readonly key: ProviderKeyDef } : { readonly key?: never })
  & (P extends SignInProviderId ? { readonly signIn: ProviderSignInDef } : { readonly signIn?: never });

/**
 * StepFun's "step-plan" SUBSCRIPTION base URL. The official Anthropic SDK (pi's anthropic-messages path)
 * appends `/v1/messages`, giving `…/step_plan/v1/messages` — the documented step-plan endpoint. This is
 * the subscription product (flat fee), NOT the pay-per-token standard API at `…/v1`.
 */
const STEPFUN_BASE_URL = 'https://api.stepfun.ai/step_plan';

export const TYPESAFE_SECRET_KEY = 'damocles.typesafe.apiKey';

/**
 * The account providers. A key provider is registered/authenticated only when its secret is present: StepFun is
 * registered fresh (pi has no first-party StepFun provider); the others are pi providers that only need their key set.
 * Key order is the sync order and Automatic's background-model priority (`AUTOMATIC_BACKGROUND_MODELS`).
 */
const ACCOUNT_PROVIDER_DEFS: { readonly [P in AccountProviderId]: AccountProviderDefOf<P> } = {
  stepfun: {
    provider: 'stepfun',
    cheapModel: 'step-5-preview',
    flatFee: true,
    key: {
      secretKey: PROVIDER_SECRET_KEYS.stepfun,
      mode: 'register',
      legacySweep: true,
      registerConfig: {
        baseUrl: STEPFUN_BASE_URL,
        api: 'anthropic-messages' as Api,
        // step-plan authenticates `Authorization: Bearer <key>`, which `authHeader: true` makes pi add beside the
        // Anthropic SDK's own `x-api-key`. Step 5 Preview is a 1M-context multimodal reasoning model. Cost is 0: the
        // step-plan subscription is a flat fee, so there's no per-token dollar metering (token usage still
        // shows, mirroring how the Anthropic subscription mode is treated).
        authHeader: true,
        models: [
          {
            id: 'step-5-preview',
            name: 'StepFun Step 5 Preview',
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            // step_plan takes reasoning effort as adaptive `output_config.effort` and REJECTS the
            // token-budget `thinking.budget_tokens` shape; `forceAdaptiveThinking` makes pi-ai's
            // anthropic-messages path emit the adaptive shape.
            compat: { forceAdaptiveThinking: true },
            // StepFun offers only low|medium|high and cannot disable thinking, so pi clamps `off` up to `low`.
            thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
          },
        ],
      },
    },
  },
  deepseek: {
    // DeepSeek is a pi BUILT-IN provider (api.deepseek.com, openai-completions). It only needs its key
    // applied as a runtime override; `registry.getModel('deepseek', …)` always resolves. Its key lives
    // in its own SecretStorage entry.
    provider: 'deepseek',
    cheapModel: 'deepseek-flash',
    key: { secretKey: 'damocles.deepseek.apiKey', mode: 'authenticate', legacySweep: true },
  },
  minimax: {
    // pi built-in (api.minimax.io, the international platform). `sk-cp-` is a Token Plan subscription key;
    // MiniMax charges the account balance only for a pay-as-you-go key.
    provider: 'minimax',
    cheapModel: 'MiniMax-M3.1-Flash',
    key: { secretKey: 'damocles.minimax.apiKey', mode: 'authenticate', flatFeeKey: (key) => key.startsWith('sk-cp-') },
  },
  xai: {
    provider: 'xai',
    cheapModel: 'grok-4.7',
    key: { secretKey: 'damocles.xai.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  'kimi-coding': {
    provider: 'kimi-coding',
    cheapModel: 'kimi-for-coding',
    flatFee: true,
    key: { secretKey: 'damocles.kimi-coding.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  meta: {
    provider: 'meta',
    cheapModel: 'muse-spark-1.3',
    key: { secretKey: 'damocles.meta.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  openrouter: {
    // Image generation, Jev on OpenRouter and template `model:` pins; no cheap model, so the Explore default never picks it.
    provider: 'openrouter',
    key: { secretKey: PROVIDER_SECRET_KEYS.openrouter, mode: 'authenticate', legacySweep: true },
    signIn: {},
  },
  typesafe: {
    // Classifier-only (Jev) for the memory judges.
    provider: 'typesafe',
    key: { secretKey: TYPESAFE_SECRET_KEY, mode: 'authenticate' },
  },
  'github-copilot': {
    // Sign-in only.
    provider: 'github-copilot',
    cheapModel: 'github-copilot/claude-haiku-5.5',
    pickedOnly: true,
    signIn: { textPrompt: 'enterpriseDomain' },
    plan: true,
    flatFee: true,
  },
};

export const CUSTOM_PROVIDER_DEFS: readonly CustomProviderDef[] = Object.values(ACCOUNT_PROVIDER_DEFS);

/** The defs with a key, in sync order. */
export const KEYED_PROVIDER_DEFS: readonly KeyedProviderDef[] = CUSTOM_PROVIDER_DEFS.filter((def): def is KeyedProviderDef => def.key !== undefined);

export function customProviderDef(provider: KeyProviderId): KeyedProviderDef {
  return ACCOUNT_PROVIDER_DEFS[provider];
}

export function accountProviderDef(provider: AccountProviderId): CustomProviderDef {
  return ACCOUNT_PROVIDER_DEFS[provider];
}

export function providerSignInDef(provider: SignInProviderId): ProviderSignInDef {
  return ACCOUNT_PROVIDER_DEFS[provider].signIn;
}

/** Whether a pi provider limits its models per account plan, so a model outside its sign-in's list is refused. */
export function providerLimitsModelsByPlan(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.plan === true);
}

/** Whether Damocles never chooses a pi provider's models on its own (`CustomProviderDef.pickedOnly`). */
export function providerPickedOnly(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.pickedOnly === true);
}

/** Whether every credential of a pi provider bills a flat subscription (`CustomProviderDef.flatFee`). */
export function providerBillsFlat(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.flatFee === true);
}

/** The key provider whose key is stored under `secretKey`, if any. */
export function keyProviderOfSecret(secretKey: string): KeyProviderId | undefined {
  return KEYED_PROVIDER_DEFS.find((d) => d.key.secretKey === secretKey)?.provider;
}

/** Resolves a provider's secret value, or undefined when unset. PromiseLike so VS Code's
 *  `SecretStorage.get` (a `Thenable`) can be passed directly. */
export type SecretResolver = (key: string) => PromiseLike<string | undefined>;

export interface SyncCustomProvidersDeps {
  modelRuntime: ModelRuntime;
  getSecret: SecretResolver;
  /** Cancels the sync — checked between providers and forwarded as `AuthOperationOptions.signal`. */
  signal?: AbortSignal;
  /** Runs before a provider's credential is replaced or removed, each of which supersedes pi's running refresh of it. */
  beforeCredentialChange?: (provider: string) => void;
  /** A daemon's core: keys come from the broker for the turn's pinned client, never as runtime overrides. */
  remote?: RemoteHost;
  /** pi's agent dir, whose auth.json says which providers hold a sign-in. */
  agentDir: string;
  /** The provider's "Prefer API key" flag. */
  preferApiKey: (provider: KeyProviderId) => boolean;
  /** Written once the one-time sweep of legacy plain-text keys in auth.json has run. */
  sweepMarkerPath: string;
  /** Providers whose sign-in is running; pi serializes each provider's credential operations, so one would stall behind that sign-in. */
  signingIn?: ReadonlySet<AccountProviderId>;
}

export interface SyncCustomProvidersResult {
  /** Providers whose key is live on the runtime. */
  wired: string[];
  /** The signal fired before every provider had been processed. */
  aborted: boolean;
  /** Configured, but not live: failed to apply, its secret could not be read, or it was never reached
   *  because the signal fired AND it is known-configured. A provider with no secret, or whose key a stored
   *  sign-in outranks, appears in neither list. Disjoint from `wired`. */
  notWired: string[];
  /** Providers whose live credential this sync replaced or removed. */
  changed: string[];
  /** Each provider whose secret this sync read, and whether a key is saved there, applied or not. */
  keysSaved: ReadonlyMap<KeyProviderId, boolean>;
}

/**
 * Last key applied per provider, so an unchanged key skips the re-apply. That re-apply no longer
 * refreshes the whole runtime under 0.85, but still enqueues a credential operation taking the
 * cross-process `auth.json` lock and re-probing availability — so the cache still earns its place, and
 * must NOT be deleted on the grounds that "the refresh is gone now". Keyed by runtime (WeakMap) so a
 * recreated runtime re-syncs from scratch. Also the billing source of `flatFeeKeyProviders`: an entry
 * changes only once pi took the key, so billing follows the credential pi sends.
 */
const syncedKeys = new WeakMap<ModelRuntime, Map<string, string>>();

/**
 * The key providers whose applied key bills a flat subscription (`CustomProviderDef.flatFeeKey`). Only ids leave this
 * module, never a key. A daemon's core applies no key, so it reads the pinned client's clientAuth.
 */
export function flatFeeKeyProviders(runtime: ModelRuntime, remote?: RemoteHost): ReadonlySet<KeyProviderId> {
  if (remote) {
    const clientId = currentPin(remote).clientId;
    const providers = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers;
    return new Set(KEYED_PROVIDER_DEFS.filter((def) => providers?.[def.provider]?.flatFee === true).map((def) => def.provider));
  }
  const cache = syncedKeys.get(runtime);
  const flat = new Set<KeyProviderId>();
  if (!cache) return flat;
  for (const def of KEYED_PROVIDER_DEFS) {
    const key = cache.get(def.provider);
    if (key !== undefined && def.key.flatFeeKey?.(key)) flat.add(def.provider);
  }
  return flat;
}

/**
 * Drop the runtime key Damocles applied, which restores pi's stored credential. Idempotent. Never logs out: that would
 * delete a stored sign-in. A fresh-registered provider (StepFun) whose key was deleted is dropped entirely, since its
 * register config carries the key; `unregisterProvider` is synchronous and takes no signal.
 */
async function removeAppliedKey(
  runtime: ModelRuntime,
  def: KeyedProviderDef,
  cache: Map<string, string>,
  keySaved: boolean,
  authOptions: AuthOperationOptions,
  beforeCredentialChange: ((provider: string) => void) | undefined,
): Promise<boolean> {
  const hadKey = cache.delete(def.provider);
  if (!hadKey && runtime.getProviderAuthStatus(def.provider).source !== 'runtime') return false;
  beforeCredentialChange?.(def.provider);
  if (def.key.mode === 'register' && !keySaved) runtime.unregisterProvider(def.provider);
  await runtime.removeRuntimeApiKey(def.provider, authOptions);
  log('[custom-providers] removed the %s runtime key (%s)', def.provider, keySaved ? 'a sign-in outranks it' : 'secret absent');
  return true;
}

/** The defs whose plain-text key the one-time sweep logs out. */
const LEGACY_SWEEP_DEFS: readonly KeyedProviderDef[] = KEYED_PROVIDER_DEFS.filter((def) => def.key.legacySweep === true);

/** This process's progress on the one-time legacy sweep of one marker path. */
interface LegacySweep {
  /** Undefined until the marker was checked; once true, the sweep never runs again in this process. */
  markerSeen: boolean | undefined;
  /** Providers holding no plain-text key any more, or none at the first look; never swept again in this process. */
  settled: Set<KeyProviderId>;
}

const legacySweeps = new Map<string, LegacySweep>();

/** The sweep of `markerPath` while it still has work, else undefined. A marker that cannot be checked skips this sync's sweep: it never logs out unsure. */
async function pendingLegacySweep(markerPath: string): Promise<LegacySweep | undefined> {
  let sweep = legacySweeps.get(markerPath);
  if (!sweep) {
    sweep = { markerSeen: undefined, settled: new Set() };
    legacySweeps.set(markerPath, sweep);
  }
  if (sweep.markerSeen === undefined) {
    try {
      await fs.promises.access(markerPath);
      sweep.markerSeen = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('[custom-providers] could not check the legacy key sweep marker; skipping the sweep: %s', describeAuthError(err));
        return undefined;
      }
      sweep.markerSeen = false;
    }
  }
  return sweep.markerSeen ? undefined : sweep;
}

/**
 * Logs out the plain-text key an older version stored for `def`; true when it logged out. The provider settles unless
 * auth.json could not be read. pi has no compare-and-delete, so the credential is read again right before the logout;
 * a sign-in that lands between this read and the logout is still lost, a window only the first start after the upgrade has.
 */
async function sweepLegacyKey(deps: SyncCustomProvidersDeps, def: KeyedProviderDef, authOptions: AuthOperationOptions, sweep: LegacySweep): Promise<boolean> {
  const now = readProviderSignIns(deps.agentDir);
  if (now === undefined) return false;
  if (now[def.provider]?.type !== 'api_key') {
    sweep.settled.add(def.provider);
    return false;
  }
  deps.beforeCredentialChange?.(def.provider);
  await deps.modelRuntime.logout(def.provider, authOptions);
  sweep.settled.add(def.provider);
  log('[custom-providers] removed the plain-text %s key an older version stored in auth.json', def.provider);
  return true;
}

async function writeSweepMarker(markerPath: string, sweep: LegacySweep): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await writeFileAtomic(markerPath, `${JSON.stringify({ sweptAt: Date.now() })}\n`);
    sweep.markerSeen = true;
  } catch (err) {
    log('[custom-providers] could not record the legacy key sweep; only the record is written again at the next sync: %s', describeAuthError(err));
  }
}

/** The outcome of one secret read. `failed` and `aborted` are deliberately distinct from a successful
 *  read of `undefined`: only the latter means the user removed the key. */
type SecretRead =
  | { status: 'read'; key: string | undefined }
  | { status: 'failed'; err: unknown }
  | { status: 'aborted' };

/**
 * VS Code's `SecretStorage.get` takes no signal and is backed by the OS keyring (libsecret /
 * gnome-keyring / DPAPI), which can wedge indefinitely — and this sync gates all user input at startup.
 * The abort listener is removed on settle because the caller's signal is the long-lived `_syncAbort`
 * one, which every subsequent sync would otherwise keep adding to.
 */
async function readSecret(getSecret: SecretResolver, secretKey: string, signal: AbortSignal | undefined): Promise<SecretRead> {
  const read = Promise.resolve(getSecret(secretKey)).then(
    (key): SecretRead => ({ status: 'read', key }),
    (err): SecretRead => ({ status: 'failed', err }),
  );
  if (!signal) return read;
  if (signal.aborted) return { status: 'aborted' };
  const settled = new AbortController();
  try {
    return await Promise.race([
      read,
      new Promise<SecretRead>((resolve) => {
        signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true, signal: settled.signal });
      }),
    ]);
  } finally {
    settled.abort();
  }
}

const KEY_PRESENCE_TIMEOUT_MS = 3000;

/** Whether a non-empty key is stored under `secretKey`; undefined when the store failed or did not answer in time. */
export async function providerKeyStored(getSecret: SecretResolver, secretKey: string): Promise<boolean | undefined> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), KEY_PRESENCE_TIMEOUT_MS);
  try {
    const read = await readSecret(getSecret, secretKey, timeout.signal);
    return read.status === 'read' ? (read.key ?? '').length > 0 : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a provider the abort cut short is known to be configured, decided WITHOUT I/O — asking
 * `getSecret` again here would reintroduce the very unbounded read the abort exists to cut short.
 * Providers that fail this are not "not wired", they have no key at all, and reporting them would turn
 * every timeout log and every user-facing fallback warning on a single-provider machine into noise.
 * A signed-in provider counts only with its key known and preferred; otherwise its sign-in serves it.
 */
function isKnownConfigured(
  runtime: ModelRuntime,
  def: KeyedProviderDef,
  cache: Map<string, string>,
  sawSecret: ReadonlySet<string>,
  signedIn: boolean,
  preferApiKey: boolean,
): boolean {
  const keyKnown = sawSecret.has(def.provider) || cache.has(def.provider);
  if (signedIn) return keyKnown && preferApiKey;
  return keyKnown || runtime.getProviderAuthStatus(def.provider).configured;
}

/**
 * Register/authenticate the key-backed providers on the SHARED runtime. StepFun is registered
 * fresh (its key in the provider config); the others are existing pi providers that only need their
 * API key. Keys are applied as in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`),
 * never persisted to auth.json and never `process.env`, and only while `providerRuntimeKeyWanted` holds.
 * A key that is not wanted has its runtime key removed (`removeAppliedKey`), and an unchanged key pi still
 * holds is skipped entirely, so the common session-start path with stable keys enqueues zero credential
 * operations. Idempotent, so safe to call on every session start and on secret change. `registerProvider`
 * needs no trailing `refresh()`; `setRuntimeApiKey` runs its own offline, single-provider one. Cancellable
 * via `deps.signal`, and what it did and did not reach is reported rather than swallowed (`SyncCustomProvidersResult`).
 */
export async function syncCustomProviders(deps: SyncCustomProvidersDeps): Promise<SyncCustomProvidersResult> {
  if (deps.remote) return registerForBroker(deps.modelRuntime, deps.remote);
  const wired: string[] = [];
  const notWired: string[] = [];
  const changed: string[] = [];
  const keysSaved = new Map<KeyProviderId, boolean>();
  const markChanged = (provider: string): void => {
    if (!changed.includes(provider)) changed.push(provider);
  };
  /** Read this sync and non-empty — the only evidence that the provider cut short mid-apply is configured. */
  const sawSecret = new Set<string>();
  let cutShortAt = -1;
  // `exactOptionalPropertyTypes` forbids `{ signal: undefined }` against pi's `signal?: AbortSignal`.
  const authOptions: AuthOperationOptions = deps.signal ? { signal: deps.signal } : {};
  let cache = syncedKeys.get(deps.modelRuntime);
  if (!cache) {
    cache = new Map();
    syncedKeys.set(deps.modelRuntime, cache);
  }
  const signIns = readProviderSignIns(deps.agentDir);
  const signedIn = (provider: string): boolean => signIns?.[provider]?.type === 'oauth';
  // The sweep must know each stored credential's type, so an unreadable auth.json defers it to a later sync.
  const sweep = signIns === undefined ? undefined : await pendingLegacySweep(deps.sweepMarkerPath);
  for (const [i, def] of KEYED_PROVIDER_DEFS.entries()) {
    if (deps.signal?.aborted) {
      cutShortAt = i;
      break;
    }
    if (sweep && def.key.legacySweep && signIns?.[def.provider]?.type !== 'api_key') sweep.settled.add(def.provider);
    const sweepDue = sweep !== undefined && def.key.legacySweep === true && !sweep.settled.has(def.provider);
    // Checked again after every await: a sign-in that starts meanwhile would queue this sync's operations behind its login.
    const signingIn = (): boolean => deps.signingIn?.has(def.provider) === true;
    if (signingIn()) continue;
    const preferApiKey = deps.preferApiKey(def.provider);
    const read = await readSecret(deps.getSecret, def.key.secretKey, deps.signal);
    if (read.status === 'aborted') {
      cutShortAt = i;
      break;
    }
    if (read.status === 'failed') {
      // A read failure is NOT an absent secret: removing or sweeping anything here could drop a credential
      // because a keyring happened to be locked.
      if (providerRuntimeKeyWanted({ key: true, signedIn: signedIn(def.provider) }, preferApiKey)) notWired.push(def.provider);
      log('[custom-providers] could not read the stored secret for %s; leaving it untouched: %s', def.provider, describeAuthError(read.err));
      continue;
    }
    const key = read.key;
    keysSaved.set(def.provider, Boolean(key));
    if (signingIn()) continue;
    if (key) sawSecret.add(def.provider);
    const wanted = providerRuntimeKeyWanted({ key: Boolean(key), signedIn: signedIn(def.provider) }, preferApiKey);
    // Before the key is applied, since pi's logout also drops the runtime key.
    if (sweepDue) {
      try {
        if (await sweepLegacyKey(deps, def, authOptions, sweep)) markChanged(def.provider);
      } catch (err) {
        // pi commits the logout before the snapshot sync this error wraps (model-runtime.js:404-437).
        if (isCredentialSyncError(err)) {
          sweep.settled.add(def.provider);
          markChanged(def.provider);
        } else {
          log('[custom-providers] could not remove the plain-text %s key; the sweep tries again at the next sync: %s', def.provider, describeAuthError(err));
        }
        if (deps.signal?.aborted) {
          cutShortAt = i;
          break;
        }
      }
      if (signingIn()) continue;
    }
    try {
      if (!key || !wanted) {
        if (await removeAppliedKey(deps.modelRuntime, def, cache, Boolean(key), authOptions, deps.beforeCredentialChange)) markChanged(def.provider);
        continue;
      }
      // A logout in this process (a sign-out, the sweep) drops pi's runtime key, so the cache alone does not say it is live.
      if (cache.get(def.provider) === key && deps.modelRuntime.getProviderAuthStatus(def.provider).source === 'runtime') {
        wired.push(def.provider);
        continue;
      }
      deps.beforeCredentialChange?.(def.provider);
      if (def.key.mode === 'register' && def.key.registerConfig) {
        deps.modelRuntime.registerProvider(def.provider, { ...def.key.registerConfig, apiKey: key });
      }
      // Apply the key as an in-memory runtime override so request-auth resolution + availability checks
      // see it (the auth mechanism for `mode: 'authenticate'` providers; harmless belt-and-braces for
      // `register` ones). Runs last per provider.
      await deps.modelRuntime.setRuntimeApiKey(def.provider, key, authOptions);
      cache.set(def.provider, key);
      wired.push(def.provider);
      markChanged(def.provider);
    } catch (err) {
      // pi commits the runtime key, or its removal, before the snapshot sync, and wraps every failure of that sync, an
      // abort included, as this error (model-runtime.js:404-437). So the key is live even when the signal fired: it
      // must be cached, or billing would follow a key pi no longer sends.
      const committed = isCredentialSyncError(err);
      if (committed && wanted && key) {
        cache.set(def.provider, key);
        wired.push(def.provider);
        log('[custom-providers] %s is wired, but pi could not resynchronize its local model snapshot (it may be stale): %s', def.provider, describeAuthError(err));
      }
      if (committed) markChanged(def.provider);
      // An uncommitted operation cancelled is not a provider failure, and its key must not be cached: pi never took it.
      if (deps.signal?.aborted) {
        // A wired provider is past the cut, so it is never also reported not wired.
        cutShortAt = committed && wanted ? i + 1 : i;
        break;
      }
      if (committed) continue;
      if (wanted) {
        notWired.push(def.provider);
        log('[custom-providers] failed to wire %s: %s', def.provider, describeAuthError(err));
      } else {
        log('[custom-providers] failed to remove the %s key: %s', def.provider, describeAuthError(err));
      }
    }
  }
  if (cutShortAt >= 0) {
    const unreached = KEYED_PROVIDER_DEFS.slice(cutShortAt)
      .filter((d) => isKnownConfigured(deps.modelRuntime, d, cache, sawSecret, signedIn(d.provider), deps.preferApiKey(d.provider)))
      .map((d) => d.provider);
    notWired.push(...unreached);
    log('[custom-providers] sync cut short (aborted); not wired: %s', unreached.join(', ') || '(none configured)');
  }
  if (sweep && LEGACY_SWEEP_DEFS.every((def) => sweep.settled.has(def.provider))) await writeSweepMarker(deps.sweepMarkerPath, sweep);
  return { wired, aborted: cutShortAt >= 0, notWired, changed, keysSaved };
}

const brokerRegistered = new WeakSet<ModelRuntime>();

// pi reads its runtime keys before any credential store, so a key there would serve every client's turns (plan "Token broker").
function registerForBroker(runtime: ModelRuntime, remote: RemoteHost): SyncCustomProvidersResult {
  if (!brokerRegistered.has(runtime)) {
    brokerRegistered.add(runtime);
    // registering queues pi's availability check of the provider, which must never run inside a turn's pin
    outsidePins(() => {
      for (const def of KEYED_PROVIDER_DEFS) if (def.key.mode === 'register' && def.key.registerConfig) runtime.registerProvider(def.provider, def.key.registerConfig);
    });
  }
  const clientId = currentPin(remote).clientId;
  const providers = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers;
  return { wired: KEYED_PROVIDER_DEFS.filter((def) => providers?.[def.provider]?.hasKey === true).map((def) => def.provider), aborted: false, notWired: [], changed: [], keysSaved: new Map() };
}

/**
 * The cheap model of the provider `mainModelValue` runs on, so a custom-provider main agent's Explore default matches
 * it. A catalog value names its own provider; only a value outside the catalog is looked up in pi's registry, since
 * one pi id can exist under several providers, and never under a `pickedOnly` provider, which a value outside the catalog
 * never runs on. Undefined for a first-party model or a provider with no cheap model, where the caller falls back to the
 * first-party cheap model.
 */
export function cheapModelValueForProvider(mainModelValue: string, registry: ModelLookup): string | undefined {
  const info = DEFAULT_MODELS.find((m) => m.value === mainModelValue);
  if (info) return info.piProvider === undefined ? undefined : CUSTOM_PROVIDER_DEFS.find((def) => def.provider === info.piProvider)?.cheapModel;
  return CUSTOM_PROVIDER_DEFS.find((def) => def.cheapModel !== undefined && !def.pickedOnly && registry.getModel(def.provider, mainModelValue) !== undefined)?.cheapModel;
}
