import type { Disposable } from "../../platform/disposable";
import type { PanelHost } from "../../platform/window-service";
import type { ChatSession } from "../chat-session";
import type { CompassService } from "../compass";
import type { PermissionHandler } from "../permission-handler";
import type { IdeContextManager } from "./ide-context-manager";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { HistoryMessage } from "../../shared/types/content";
import type { ForkContext, RewindHistoryItem, StoredSession } from "../../shared/types/session";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";

export const SESSIONS_PAGE_SIZE = 20;

export interface CompassViewsOptions {
  /** The folder whose trust gates registering the window's views. */
  viewsFolder: () => string;
  /** Creates the service for the views' folder when it has none yet, so Rebuild can start it. */
  acquireActive?: () => CompassService | null;
}

/** The window's single set of Compass views, which the host builds and points at one folder's service at a time. */
export interface CompassViewsHandle extends Disposable {
  /** Registers the views once Compass is enabled in a trusted window. */
  register(): void;
  /** `description` names the service's folder. */
  setActive(service: CompassService | null, description?: string): void;
}

export interface HostInstance {
  host: PanelHost;
  /** Replaced, never mutated, when the panel switches folder; read it from the instance, not a copy. */
  session: ChatSession;
  folder: FolderTarget;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  disposables: Disposable[];
  forkContext?: ForkContext;
  /** Resolves once the webview posts its first `ready` message; the fork replay awaits this so its
   *  extension-initiated push doesn't race the webview's listener registration. */
  webviewReady?: Promise<void>;
}

/** A settings view outside the chat page (the desktop overlay) attached to one chat panel. */
export interface AttachedView {
  /** Called from inside attachView too, with the host prompts the attach moves into this view. */
  post(message: ExtensionToWebviewMessage): void;
  /** Called once, when the panel closes, another view is attached in its place or a dispose detaches it. */
  detached(): void;
}

export type { StoredSession, HistoryMessage, RewindHistoryItem, McpServerConfig };
