import type { CommitMessageComplete } from '../../core/scm/commit-message';
import { UNREACHABLE, type StructuredCompletionRequest, type StructuredCompletionResult } from '../../core/pi-session/structured-completion';

// What a structured sub-call needs of PiRuntime.
export interface SubCallRuntime {
  folder(cwd: string): Promise<unknown>;
  syncCustomProviders(getSecret: (key: string) => PromiseLike<string | undefined>): Promise<unknown>;
  runStructuredCompletion<T>(request: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
}

/**
 * Generate commit message's sub-call, with the runtime prepared as a chat's start prepares it: the project's folder runtime,
 * whose provider registrations the Background model resolves against, and the key-backed providers. runtime creates the
 * runtime when no chat has, and answers null once shutdown retired it.
 */
export function backgroundCompletion(runtime: () => SubCallRuntime | null, getSecret: (key: string) => PromiseLike<string | undefined>, log: (line: string) => void): CommitMessageComplete {
  return async (request) => {
    const live = runtime();
    const cwd = request.attribution?.cwd;
    if (!live || cwd === undefined) return UNREACHABLE;
    try {
      await live.folder(cwd);
      await live.syncCustomProviders(getSecret);
    } catch (err) {
      log(`[scm] the model runtime could not start: ${err instanceof Error ? err.message : String(err)}`);
      return UNREACHABLE;
    }
    return live.runStructuredCompletion<{ message?: unknown }>(request);
  };
}
