// The askpass server's prompt bridge (plan AD4, "Askpass"): what each credential prompt core's askpass server asks shows in
// the overlay (core-host/scm.ts sends it as askpass.prompt).
import type { CredentialKind } from '../core-protocol';
import type { AskMessage } from './message-dialog';
import type { AskInput } from './overlay';

export interface AskpassBridgeDeps {
  readonly ask: AskMessage;
  readonly askInput: AskInput;
  readonly t: (message: string) => string;
}

export interface CredentialAnswer {
  readonly answer?: string;
  // the user dismissed the prompt, which cancels its git call
  readonly cancelled: boolean;
}

export type AskCredential = (prompt: { readonly kind: CredentialKind; readonly text: string }, signal: AbortSignal) => Promise<CredentialAnswer>;

const CANCELLED: CredentialAnswer = { cancelled: true };
const NOTHING: CredentialAnswer = { cancelled: false };

/**
 * A username in the plain box, a password, passphrase or other secret in the masked one, an SSH yes/no question (a host key,
 * or SSH_ASKPASS_PROMPT=confirm) as a danger question whose No takes focus, and ssh's notice (SSH_ASKPASS_PROMPT=none) as
 * an information dialog its withdrawal closes. git's text is shown as plain text only, and every prompt is withdrawn
 * with its signal. A box or question the user dismissed answers cancelled, a withdrawn one nothing.
 */
export function createAskpassBridge(deps: AskpassBridgeDeps): AskCredential {
  const { t } = deps;
  return async (prompt, signal) => {
    const detail = prompt.text === '' ? {} : { detail: prompt.text };
    if (prompt.kind === 'confirm') {
      const choice = await deps.ask({ severity: 'danger', message: t('Are you sure you want to continue connecting?'), ...detail, actions: [t('Yes')], cancelLabel: t('No') }, signal);
      if (signal.aborted) return NOTHING;
      return choice === 0 ? { answer: 'yes', cancelled: false } : CANCELLED;
    }
    if (prompt.kind === 'notice') {
      await deps.ask({ severity: 'info', message: t('SSH is waiting for you.'), ...detail, actions: [t('OK')], defaultAction: 0 }, signal);
      return NOTHING;
    }
    const placeholder = prompt.kind === 'username' ? t('Username') : prompt.kind === 'passphrase' ? t('Passphrase') : t('Password');
    const text = prompt.text === '' ? t('Git asks for credentials.') : prompt.text;
    const answer = await deps.askInput({ title: t('Git Authentication'), prompt: text, placeholder, ...(prompt.kind === 'username' ? {} : { password: true }) }, signal);
    if (signal.aborted) return NOTHING;
    return answer === undefined ? CANCELLED : { answer, cancelled: false };
  };
}
