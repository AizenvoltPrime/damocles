import * as vscode from 'vscode';
import type { DesignHost } from '../../platform/design-host';
import type { Disposable } from '../../platform/disposable';
import type { ShellService } from '../../platform/shell-service';
import { readServedDesignFile } from '../../core/design/design-file-read';
import { DesignHttpServer } from '../../core/design/design-http-server';
import { log } from '../../core/logger';

// The extension host serves only the designs of its own chats.
const AUTHORITY = 'local';

/** Runs the design server in the extension host; a remote window's browser reaches it through VS Code's port forwarding (PD-19). */
export function createVsCodeDesignHost(shell: ShellService): DesignHost & Disposable {
  const folders = new Map<string, string>();
  const server = new DesignHttpServer(async ({ designId }, relPath) => {
    const folder = folders.get(designId);
    return folder === undefined ? { kind: 'missing' } : readServedDesignFile(folder, designId, relPath);
  });
  return {
    openInBrowser: async (designId, folder, relPath) => {
      folders.set(designId, folder);
      const local = await server.urlOf({ authority: AUTHORITY, designId }, relPath);
      // A forwarded port reaches the server under another Host, the authority asExternalUri names (R8).
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(local));
      const externalUrl = external.toString();
      // The Host a browser sends is the WHATWG serialization (default port dropped, punycode); canParse never throws, so no error carries the token.
      if (URL.canParse(externalUrl)) server.allowHost(new URL(externalUrl).host);
      else log('[DesignHost] the forwarded URL of design %s does not parse, so only the loopback Host is accepted', designId);
      // openExternal resolves a loopback URL itself, onto the forward asExternalUri made; the external URL would be forwarded again.
      return (await shell.openExternal(local)) ? externalUrl : undefined;
    },
    closeDesign: (designId) => {
      folders.delete(designId);
      server.revoke({ authority: AUTHORITY, designId });
    },
    dispose: () => {
      folders.clear();
      void server.dispose();
    },
  };
}
