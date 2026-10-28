// Main's own askpass server, which answers only ssh transports: each attempt registers with its own prompt, so a prompt
// reaches the attempt (and the host) whose ssh asked it. Core's askpass server for git stays core's.
import * as path from 'node:path';
import { createAskpassServer, PROMPT_CANCELLED, type AskpassPaths, type AskpassServer, type CredentialPrompt, type PromptCredential } from '../../../../core/scm/askpass/askpass-server';
import type { SshPrompt, SshPromptAnswer } from '../../../preload/overlay-channels';
import type { HostSecrets } from './remembered-secrets';
import type { SshHop } from './ssh-config';
import { matchHopPrompt, type HopBinding } from './ssh-prompt-match';

// OpenSSH 8.4 added the `(user@host) ` prefix to keyboard-interactive prompts; before it a server's text reaches askpass as sent
const HOP_PREFIX_VERSION = [8, 4] as const;

/** The helper paths ssh gets: docs/invariants.md "Remote daemon and wire", the askpass bullet. */
export function mainAskpassPaths(paths: AskpassPaths, platform: NodeJS.Platform = process.platform): AskpassPaths {
  if (platform !== 'win32') return paths;
  return { ...paths, sshAskpass: path.win32.join(path.win32.dirname(paths.sshAskpass), 'ssh-askpass.exe') };
}

export function createMainAskpassServer(deps: { readonly paths: AskpassPaths; readonly log: (line: string) => void; readonly platform?: NodeJS.Platform }): AskpassServer {
  return createAskpassServer({
    paths: mainAskpassPaths(deps.paths, deps.platform),
    // every registration brings its own prompt
    prompt: async () => {
      deps.log('[ssh-askpass] a prompt arrived for a registration without its own prompt; it was cancelled');
      return PROMPT_CANCELLED;
    },
    log: deps.log,
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  });
}

export interface HostKeyQuestion {
  readonly host: string;
  readonly keyType: string;
  readonly fingerprint: string;
}

/** ssh's unknown-host confirmation: the host as ssh names it, the key type and the fingerprint. */
export function parseHostKeyPrompt(text: string): HostKeyQuestion | undefined {
  // ssh's own question starts the text; a server's keyboard-interactive text quoting it does not
  const host = /^The authenticity of host '([^' ]+)(?: \([^)]*\))?' can't be established/.exec(text)?.[1];
  // OpenSSH 10 prints "key fingerprint is: SHA256:..."; earlier versions have no colon
  const key = /\b([A-Z0-9-]{2,32}) key fingerprint is:? ((?:SHA256|MD5):[A-Za-z0-9+/=:]+?)\.?$/m.exec(text);
  if (host === undefined || !key) return undefined;
  return { host, keyType: key[1]!, fingerprint: key[2]! };
}

export type SecretKind = Extract<SshPrompt, { kind: 'secret' }>['secretKind'];

const NAMES_A_SECRET = /password|passcode|passphrase|\bpin\b/i;
const CODE_WORDING = /\b(?:verification code|one-time code|otp|token|authenticator|2fa|two-factor|duo)\b/i;

/** The label a secret prompt shows; the field is masked whatever the kind. */
export function secretKindOf(prompt: CredentialPrompt): SecretKind {
  if (prompt.kind === 'passphrase') return 'passphrase';
  if (/password/i.test(prompt.text)) return 'password';
  if (/\bpin\b/i.test(prompt.text)) return 'pin';
  if (!NAMES_A_SECRET.test(prompt.text) && CODE_WORDING.test(prompt.text)) return 'otp';
  return 'other';
}

export interface AttemptPromptState {
  // the user cancelled a host key question, so ssh's "Host key verification failed" is their refusal
  hostKeyRefused: boolean;
  // the user dismissed a secret prompt
  cancelled: boolean;
}

// One attempt's answers for prompts bound to one hop: what the user typed earlier in the attempt, held in memory until the
// attempt ends, so each ssh the attempt runs (a detection, then stage 0) authenticates with one question; then what the
// host's store remembers, and what the user asked to remember, stored only once ssh authenticated.
export interface RememberedAttempt {
  // the hop binding of a password or passphrase prompt, else undefined; undefined at once when signal aborts first
  bind(prompt: CredentialPrompt, signal: AbortSignal): Promise<HopBinding | undefined>;
  // the latest answer typed for this prompt in the attempt, else the stored one, given once per binding until ssh
  // authenticated; a binding prompting again before that refused it, so it is dropped and undefined returned
  stored(binding: HopBinding, text: string): Promise<string | undefined>;
  // the host's Remember password setting: the prompt offers "Remember on this computer"
  readonly offer: boolean;
  // the user's answer to a bound prompt, kept for the attempt; with remember it is stored once ssh authenticated
  answered(binding: HopBinding, text: string, answer: string, remember: boolean): void;
  // an ssh of the attempt authenticated: the answers the user asked to remember are stored, and what was given is forgotten
  authenticated(): void;
  // the attempt ended, whatever its outcome: every answer typed in it is forgotten
  end(): void;
}

export interface RememberedAttemptDeps {
  readonly offer: boolean;
  // the host's store while its Remember password setting is on; without it nothing is read or stored
  readonly secrets?: HostSecrets;
  // `ssh -G` for every hop, run on the first secret prompt
  readonly hops: () => Promise<readonly SshHop[]>;
  // the passwd entry's home, which ssh expands `~` with; undefined for an account without one
  readonly home: string | undefined;
  // the client's OpenSSH version as `ssh -V` names it; undefined when it names none
  readonly sshVersion: readonly [number, number] | undefined;
  readonly log: (line: string) => void;
}

// value's result, or undefined once signal aborted first; value itself goes on
function untilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = (): void => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const prefixesPrompts = (version: readonly [number, number] | undefined): boolean =>
  version !== undefined && (version[0] > HOP_PREFIX_VERSION[0] || (version[0] === HOP_PREFIX_VERSION[0] && version[1] >= HOP_PREFIX_VERSION[1]));

// Why a prompt binds to no hop, or undefined when its binding stands (docs/invariants.md "Remote daemon and wire").
function unboundReason(binding: HopBinding | undefined, hops: readonly SshHop[], prefixed: boolean): string | undefined {
  if (hops.some((hop) => hop.proxyCommand)) return 'a ProxyCommand connection may hold hops ssh -G does not list';
  if (!binding) return 'no hop or more than one hop asks with this text';
  if (prefixed) return undefined;
  if (binding.kind === 'passphrase') return 'OpenSSH before 8.4 lets a server send this text';
  if (hops.length !== 1) return 'OpenSSH before 8.4 lets a jump host send another hop\'s prompt';
  return undefined;
}

export function rememberedAttempt(deps: RememberedAttemptDeps): RememberedAttempt {
  const { secrets, log } = deps;
  const prefixed = prefixesPrompts(deps.sshVersion);
  let hops: Promise<readonly SshHop[]> | undefined;
  const keyOf = (binding: HopBinding): string =>
    JSON.stringify([binding.hop.hostname, binding.hop.port, binding.hop.user, binding.kind, binding.kind === 'passphrase' ? binding.identityFile : '']);
  // bindings answered in the current ssh; a second prompt for one means its answer was refused
  const given = new Set<string>();
  // the latest answer the user typed for each prompt text of a binding in this attempt: an answer never reaches another hop
  const attemptAnswers = new Map<string, Map<string, string>>();
  const typed = new Map<string, { readonly binding: HopBinding; readonly answer: string }>();
  // bindings refused in this attempt, whose stored answer is not offered again even when deleting it failed
  const refusedStored = new Set<string>();
  // the stores the last authentication started, which a later ssh process of the attempt reads back
  let storing: Promise<unknown> = Promise.resolve();
  return {
    offer: deps.offer,
    async bind(prompt, signal) {
      if (prompt.kind !== 'password' && prompt.kind !== 'passphrase') return undefined;
      hops ??= deps.hops().catch((err: unknown) => {
        log(`the hops could not be resolved, so every prompt is asked: ${messageOf(err)}`);
        return [];
      });
      const resolved = await untilAborted(hops, signal);
      if (!resolved) return undefined;
      const binding = matchHopPrompt(prompt.text, resolved, deps.home);
      const reason = unboundReason(binding, resolved, prefixed);
      if (reason === undefined) return binding;
      log(`prompt ${JSON.stringify(prompt.text)} is bound to no hop (${reason}), so it is asked and never answered for the user`);
      return undefined;
    },
    async stored(binding, text) {
      const key = keyOf(binding);
      typed.delete(key);
      if (given.has(key)) {
        given.delete(key);
        attemptAnswers.delete(key);
        refusedStored.add(key);
        await secrets?.delete(binding).catch((err: unknown) => log(`deleting the refused ${binding.kind} for ${binding.hop.alias} failed: ${messageOf(err)}`));
        log(`${binding.hop.alias} refused an answer; the ${binding.kind} for it is asked again`);
        return undefined;
      }
      const typedEarlier = attemptAnswers.get(key)?.get(text);
      if (typedEarlier !== undefined) {
        given.add(key);
        log(`answered ${JSON.stringify(text)} with the ${binding.kind} typed earlier in this attempt`);
        return typedEarlier;
      }
      if (!secrets || refusedStored.has(key)) return undefined;
      await storing;
      let value: string | undefined;
      try {
        value = await secrets.get(binding);
      } catch (err) {
        log(`reading the remembered ${binding.kind} for ${binding.hop.alias} failed, so it is asked: ${messageOf(err)}`);
        return undefined;
      }
      if (value !== undefined) given.add(key);
      return value;
    },
    answered(binding, text, answer, remember) {
      const key = keyOf(binding);
      given.add(key);
      const answers = attemptAnswers.get(key) ?? new Map<string, string>();
      answers.set(text, answer);
      attemptAnswers.set(key, answers);
      if (remember && deps.offer && secrets) typed.set(key, { binding, answer });
    },
    // An attempt may run more than one ssh (a detection, then stage 0), each authenticating on its own: a later one's prompt
    // for a binding is a new question, not a refusal, so what was given is forgotten here.
    authenticated() {
      given.clear();
      const pending = [...typed.values()];
      typed.clear();
      storing = Promise.all([storing, ...pending.map(({ binding, answer }) => secrets!.store(binding, answer).then(
        (stored) => {
          if (!stored) {
            log(`the ${binding.kind} for ${binding.hop.alias} was not remembered: the host's remembered answers were deleted during the sign-in`);
            return;
          }
          refusedStored.delete(keyOf(binding));
          log(`remembered the ${binding.kind} for ${binding.hop.alias}`);
        },
        (err: unknown) => log(`remembering the ${binding.kind} for ${binding.hop.alias} failed: ${messageOf(err)}`),
      ))]);
    },
    end() {
      attemptAnswers.clear();
      typed.clear();
      given.clear();
      refusedStored.clear();
    },
  };
}

/**
 * One attempt's askpass prompt: a host key question becomes the hostKey prompt, whose Connect answers ssh's own question
 * with `yes` (ssh then records the key itself), and every other question a secret prompt. A confirmation that is not a host
 * key question and ssh's notices are never answered yes. A prompt bound to exactly one hop is answered once per ssh from
 * what the user typed for it earlier in the attempt, else from the store; any other prompt, a code included, is asked.
 */
export function attemptPrompt(ask: (prompt: SshPrompt, signal: AbortSignal) => Promise<SshPromptAnswer | undefined>, state: AttemptPromptState, log: (line: string) => void, remembered?: RememberedAttempt): PromptCredential {
  return async (prompt, signal) => {
    if (prompt.kind === 'notice') {
      log(`ssh notice: ${JSON.stringify(prompt.text)}`);
      return undefined;
    }
    if (prompt.kind === 'confirm') {
      const question = parseHostKeyPrompt(prompt.text);
      if (!question) {
        log(`refused a confirmation that is not a host key question: ${JSON.stringify(prompt.text)}`);
        return PROMPT_CANCELLED;
      }
      const answer = await ask({ kind: 'hostKey', ...question }, signal);
      if (answer?.answer === 'connect') return 'yes';
      // a question ssh withdrew was never refused
      if (!signal.aborted) state.hostKeyRefused = true;
      return PROMPT_CANCELLED;
    }
    const binding = await remembered?.bind(prompt, signal);
    // ssh withdrew the prompt while its hops resolved
    if (signal.aborted) return PROMPT_CANCELLED;
    if (binding) {
      const stored = await remembered!.stored(binding, prompt.text);
      if (stored !== undefined) return stored;
    }
    const offerRemember = binding !== undefined && remembered!.offer;
    const secretKind = secretKindOf(prompt);
    log(`asking the user: ${secretKind} prompt ${JSON.stringify(prompt.text)}`);
    const answer = await ask({ kind: 'secret', secretKind, text: prompt.text, ...(offerRemember ? { offerRemember: true as const } : {}) }, signal);
    if (answer === undefined) {
      if (!signal.aborted) state.cancelled = true;
      return PROMPT_CANCELLED;
    }
    if (binding) remembered!.answered(binding, prompt.text, answer.answer, offerRemember && answer.remember);
    return answer.answer;
  };
}
