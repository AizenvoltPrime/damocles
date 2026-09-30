function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/**
 * Routes an uncaught exception or unhandled rejection in main to the log, as VS Code's main process does, instead of
 * Electron's "A JavaScript error occurred in the main process" dialog or a line on a stderr nobody reads.
 */
export function logUncaughtErrors(target: NodeJS.EventEmitter, log: (line: string) => void): void {
  target.on('uncaughtException', (err: unknown) => log(`[main] uncaught exception: ${errorText(err)}`));
  target.on('unhandledRejection', (reason: unknown) => log(`[main] unhandled rejection: ${errorText(reason)}`));
}
