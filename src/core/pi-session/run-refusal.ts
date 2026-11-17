import type { AgentSession, PromptOptions } from '@earendil-works/pi-coding-agent';

/**
 * Thrown from a prompt's `preflightResult('started')` to refuse the run pi is about to open with it: pi opens none, writes
 * nothing of the prompt, keeps the nextTurn messages for the next run and rejects that `prompt()` with it (patches/README.md, 002).
 */
export class RunRefused extends Error {
  constructor() {
    super('The run was refused before it started.');
    this.name = 'RunRefused';
  }
}

/**
 * `session.prompt()` for a prompt whose `preflightResult` may throw `RunRefused`: false when pi refused this prompt's run.
 * A prompt pi deferred into a settle resolved its `prompt()` before its verdict, and pi rejects nothing for its refusal
 * (patches/README.md, 002), so a caller acts on a refusal in its `preflightResult`.
 */
export async function promptRefusable(session: AgentSession, text: string, options: PromptOptions): Promise<boolean> {
  try {
    await session.prompt(text, options);
  } catch (err) {
    if (err instanceof RunRefused) return false;
    throw err;
  }
  return true;
}
