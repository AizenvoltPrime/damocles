function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/**
 * Routes an uncaught exception or unhandled rejection to the process's log, as VS Code's main and extension host do, instead
 * of Electron's "A JavaScript error occurred in the main process" dialog or a line on a stderr nobody reads.
 */
export function logUncaughtErrors(target: NodeJS.EventEmitter, label: 'main' | 'core', log: (line: string) => void): void {
  target.on('uncaughtException', (err: unknown) => log(`[${label}] uncaught exception: ${errorText(err)}`));
  target.on('unhandledRejection', (reason: unknown) => log(`[${label}] unhandled rejection: ${errorText(reason)}`));
}
