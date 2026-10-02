export interface AppInfo {
  readonly version: string;
  // Each host keeps its own secret store, so state shared through ~/.damocles names the host that wrote it.
  readonly host: 'vscode' | 'desktop';
}
