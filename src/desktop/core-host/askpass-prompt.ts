import { PROMPT_CANCELLED, type CredentialPrompt, type PromptCredential } from '../../core/scm/askpass/askpass-server';

/** The askpass server's prompt, answered by main's overlay (askpass.prompt); the answer is a credential and appears in no log line or error text. */
export function credentialPrompt(ask: (prompt: CredentialPrompt, signal: AbortSignal) => Promise<{ readonly answer?: string; readonly cancelled: boolean }>): PromptCredential {
  return async (prompt, signal) => {
    const { answer, cancelled } = await ask({ kind: prompt.kind, text: prompt.text }, signal);
    if (signal.aborted) return undefined;
    return cancelled ? PROMPT_CANCELLED : answer;
  };
}
