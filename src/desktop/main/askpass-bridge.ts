// The askpass server's prompt bridge (plan AD4, "Askpass"): what each credential prompt shows in the overlay.
import type { PromptCredential } from '../../core/scm/askpass/askpass-server';
import type { AskMessage } from './message-dialog';
import type { AskInput } from './overlay';

export interface AskpassBridgeDeps {
  readonly ask: AskMessage;
  readonly askInput: AskInput;
  readonly t: (message: string) => string;
}

/**
 * A username in the plain box, a password, passphrase or other secret in the masked one, an SSH yes/no question (a host key,
 * or SSH_ASKPASS_PROMPT=confirm) as a danger question whose No takes focus, and ssh's notice (SSH_ASKPASS_PROMPT=none) as
 * an information dialog its withdrawal closes. git's text is shown as plain text only, and every prompt is withdrawn
 * with its signal.
 */
export function createAskpassBridge(deps: AskpassBridgeDeps): PromptCredential {
  const { t } = deps;
  return async (prompt, signal) => {
    const detail = prompt.text === '' ? {} : { detail: prompt.text };
    if (prompt.kind === 'confirm') {
      const choice = await deps.ask({ severity: 'danger', message: t('Are you sure you want to continue connecting?'), ...detail, actions: [t('Yes')], cancelLabel: t('No') }, signal);
      return choice === 0 && !signal.aborted ? 'yes' : undefined;
    }
    if (prompt.kind === 'notice') {
      await deps.ask({ severity: 'info', message: t('SSH is waiting for you.'), ...detail, actions: [t('OK')], defaultAction: 0 }, signal);
      return undefined;
    }
    const placeholder = prompt.kind === 'username' ? t('Username') : prompt.kind === 'passphrase' ? t('Passphrase') : t('Password');
    const text = prompt.text === '' ? t('Git asks for credentials.') : prompt.text;
    return deps.askInput({ title: t('Git Authentication'), prompt: text, placeholder, ...(prompt.kind === 'username' ? {} : { password: true }) }, signal);
  };
}
