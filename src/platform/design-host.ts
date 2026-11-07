/**
 * Serves designs to the user's browser from this host (PD-10, PD-19). Only VS Code has one: desktop opens a design in the
 * browser only from main-owned UI, never at a core's request (PD-35).
 */
export interface DesignHost {
  /**
   * Serves design `designId` from `folder` on the host's loopback server and opens `relPath` (relative to the folder, '/'
   * separated) in the user's browser. Resolves the URL the browser was given, or undefined when the host declined to open it.
   */
  openInBrowser(designId: string, folder: string, relPath: string): Promise<string | undefined>;
  /** No chat of design `designId` is open any more, so its served URL stops working. */
  closeDesign(designId: string): void;
}
