/** The folder key a chat webview persisted in its state; the panel manager accepts it only if that folder is open. */
export function restoredWorkspaceFolderKey(state: unknown): string | undefined {
  const raw = (state as { workspaceFolderKey?: unknown } | null)?.workspaceFolderKey;
  return typeof raw === 'string' ? raw : undefined;
}
