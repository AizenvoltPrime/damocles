import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Not exported from pi's package index, so this loads the file pi's `AgentSession` imports it from.
const PI_AUTH_GUIDANCE = resolve(__dirname, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'auth-guidance.js');

/** pi's own `formatNoApiKeyFoundMessage`, the text `AgentSession.prompt` throws for a provider with no credential. */
export async function loadFormatNoApiKeyFoundMessage(): Promise<(provider: string) => string> {
  const guidance = (await import(/* @vite-ignore */ pathToFileURL(PI_AUTH_GUIDANCE).href)) as { formatNoApiKeyFoundMessage: (provider: string) => string };
  return guidance.formatNoApiKeyFoundMessage;
}
