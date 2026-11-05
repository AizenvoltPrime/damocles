export interface ShellService {
  // Opens only http and https urls, in the canonical form; resolves false when the host declined or could not open it.
  openExternal(url: string): Promise<boolean>;
  // Shows an absolute folder in the operating system's file manager; resolves false for anything that is not a folder, so a file is never launched, and for a path the host refuses; rejects when the host cannot check it.
  openFolder(absolutePath: string): Promise<boolean>;
  // Shows an absolute path in the host's file explorer; rejects when the host cannot check it.
  revealPath(absolutePath: string): Promise<void>;
}
