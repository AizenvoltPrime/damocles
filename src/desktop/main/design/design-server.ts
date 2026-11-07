// Open in browser on desktop (PD-10, PD-35): core's loopback server (D73 to D77), run in main and reading each file through the chat's
// own core, so local, SSH, WSL and container chats serve alike with no listener on the target. Only main's own UI opens it.
import { DesignHttpServer, type DesignServeRead, type DesignServeTarget } from '../../../core/design/design-http-server';
import type { DesignPreviewFile } from '../../../shared/types/design';

export interface DesignServerDeps {
  // design.read on the target's authority's own core
  readonly read: (target: DesignServeTarget, relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>;
  // ShellService.openExternal, which opens only canonical http and https
  readonly openExternal: (url: string) => Promise<boolean>;
}

export class DesignServer {
  private readonly server: DesignHttpServer;
  private readonly openExternal: (url: string) => Promise<boolean>;

  constructor(deps: DesignServerDeps) {
    this.openExternal = deps.openExternal;
    this.server = new DesignHttpServer(async (target, relPath): Promise<DesignServeRead> => {
      const file = await deps.read(target, relPath);
      if (file === undefined) return { kind: 'missing' };
      return file === 'tooLarge' ? { kind: 'tooLarge' } : { kind: 'file', bytes: file.bytes, fidelity: file.fidelity };
    });
  }

  /** A user's click: mints the design's token on its first open and opens relPath in the user's browser. */
  async open(target: DesignServeTarget, relPath: string): Promise<boolean> {
    return this.openExternal(await this.server.urlOf(target, relPath));
  }

  /** The design's URLs stop working; called when its last tab and chat of this window closed. */
  revoke(target: DesignServeTarget): void {
    this.server.revoke(target);
  }

  /** The bound port while a token is live, for tests. */
  boundPort(): number | undefined {
    return this.server.boundPort();
  }

  dispose(): Promise<void> {
    return this.server.dispose();
  }
}
