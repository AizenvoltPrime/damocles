import type { AuthFailure, ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ModelInfo } from '../../shared/types/settings';
import { accountSignsIn, accountTakesKey, isAccountProviderId, type SettingsAccountId } from '../../shared/settings-sections';
import { MODEL_VENDOR_NAMES, catalogEntryOfPiModel } from '../../shared/model-vendor';
import { english, t } from '../l10n';
import { httpStatusOf } from './http-status';

/** The Accounts row whose credential a pi provider uses; undefined for a provider no row signs in to. */
export function accountOfProvider(provider: string | undefined): SettingsAccountId | undefined {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai' || provider === 'openai-codex') return 'openai';
  return isAccountProviderId(provider) ? provider : undefined;
}

/** The Accounts row a catalog model signs in through. */
export function accountOfModel(info: ModelInfo): SettingsAccountId | undefined {
  if (info.backend === 'openai') return 'openai';
  return info.piProvider ? accountOfProvider(info.piProvider) : 'anthropic';
}

/**
 * A provider refusing the credential: HTTP 401, else text with "unauthorized", "authentication" or "invalid api key", or
 * "oauth", which also matches pi's own "OAuth auth derivation failed for <provider>" and "OAuth refresh failed for <provider>".
 */
function isAuthError(message: string): boolean {
  if (httpStatusOf(message) === 401) return true;
  const m = message.toLowerCase();
  return m.includes('unauthorized') || m.includes('authentication') || m.includes('invalid api key') || m.includes('oauth');
}

const PI_LOGIN_HELP = 'Use /login to log into a provider via OAuth or API key. See:';

// pi's wrappers around the error a compaction failed on: `AgentSession.compact` and `_runAutoCompaction` (agent-session.js),
// then the labels `getSummarizationFailure` gets in compaction.js.
const COMPACTION_PREFIXES = ['Compaction failed: ', 'Auto-compaction failed: ', 'Context overflow recovery failed: '] as const;
const SUMMARY_PREFIXES = ['Summarization failed: ', 'Turn prefix summarization failed: '] as const;

/** The error a compaction failed on, out of pi's wrappers; any other text as it is. */
function innerError(message: string): string {
  const outer = COMPACTION_PREFIXES.find((prefix) => message.startsWith(prefix));
  const inner = outer ? message.slice(outer.length) : message;
  const summary = SUMMARY_PREFIXES.find((prefix) => inner.startsWith(prefix));
  return summary ? inner.slice(summary.length) : inner;
}

/**
 * pi's own text for a call it made no request for because `provider` had no credential. pi exports no code for it, so
 * only these exact shapes match, each naming that provider.
 */
function lacksCredential(provider: string, message: string): boolean {
  // pi `ModelRuntime.prepareRequest`, the failed model call's whole `errorMessage`: no credential, or a provider Damocles
  // registers only with its key (StepFun) once that key is cleared.
  if (message === `Provider is not configured: ${provider}` || message === `Unknown provider: ${provider}`) return true;
  // pi's `formatNoApiKeyFoundMessage` (`auth-guidance.js`), thrown by `AgentSession.prompt` before it opens a run.
  const lines = message.split('\n');
  return (
    lines.length === 5 &&
    lines[0] === `No API key found for ${provider}.` &&
    lines[1] === '' &&
    lines[2] === PI_LOGIN_HELP &&
    /^ {2}\S.*providers\.md$/.test(lines[3]!) &&
    /^ {2}\S.*models\.md$/.test(lines[4]!)
  );
}

/**
 * The one classifier of a failed model call as an account's credential failing, read by the live card and by its
 * replay. A provider with an Accounts row names that row; xAI answers 402 to a credential without API access, read
 * from the status, never the body. The missing-credential check runs first: pi's text for it mentions OAuth. A failed
 * compaction is read by the error inside pi's wrappers.
 */
export function accountFailureOf(provider: string | undefined, message: string): AuthFailure | undefined {
  const account = accountOfProvider(provider);
  if (!account || !provider) return undefined;
  const inner = innerError(message);
  if (lacksCredential(provider, inner)) return { account, reason: 'missing' };
  if (account === 'xai' && httpStatusOf(inner) === 402) return { account, reason: 'noApiAccess' };
  return isAuthError(inner) ? { account, reason: 'rejected' } : undefined;
}

/** Who reads a failed call's text: the model, always in English, or the user, in the UI language. */
export type FailureReader = 'model' | 'user';

const NO_KEY = 'No {0} credential is saved, so {1} could not run. Add an API key in Settings › Models & accounts.';
const NO_SIGN_IN = 'No {0} credential is saved, so {1} could not run. Sign in to {0} in Settings › Models & accounts.';
const NO_KEY_OR_SIGN_IN = 'No {0} credential is saved, so {1} could not run. Sign in or add an API key in Settings › Models & accounts.';
const NO_ROW = 'No credential is set up for {0}, so {1} could not run. Pick a model from a provider you are signed in to.';

/**
 * Damocles' text for a call pi made no request for because `provider` had no credential, naming the provider and the
 * model and what its Accounts row takes, since pi's own text carries its CLI login help and install paths; undefined
 * for any other failure.
 */
export function missingCredentialText(provider: string | undefined, model: string | undefined, message: string, reader: FailureReader): string | undefined {
  if (!provider || !lacksCredential(provider, innerError(message))) return undefined;
  const name = (model && catalogEntryOfPiModel(provider, model)?.displayName) || model || provider;
  const forModel = reader === 'model';
  const account = accountOfProvider(provider);
  if (!account) return forModel ? english(NO_ROW, provider, name) : t(NO_ROW, provider, name);
  const vendor = MODEL_VENDOR_NAMES[account];
  if (!accountTakesKey(account)) return forModel ? english(NO_SIGN_IN, vendor, name) : t(NO_SIGN_IN, vendor, name);
  if (!accountSignsIn(account)) return forModel ? english(NO_KEY, vendor, name) : t(NO_KEY, vendor, name);
  return forModel ? english(NO_KEY_OR_SIGN_IN, vendor, name) : t(NO_KEY_OR_SIGN_IN, vendor, name);
}

/** A failed call's text where no account card shows, with pi's own text for a missing credential replaced. */
export function failureText(provider: string | undefined, model: string | undefined, message: string, reader: FailureReader): string {
  return missingCredentialText(provider, model, message, reader) ?? message;
}

/**
 * A failed call's card for the webview, live and replayed: the account's when `accountFailureOf` names one, else the plain
 * error, in Damocles' words for a missing credential of a provider with no Accounts row.
 */
export function failureCard(provider: string | undefined, model: string | undefined, message: string): Extract<ExtensionToWebviewMessage, { type: 'authFailure' | 'error' }> {
  const failure = accountFailureOf(provider, message);
  return failure ? { type: 'authFailure', message, ...failure } : { type: 'error', message: failureText(provider, model, message, 'user') };
}
