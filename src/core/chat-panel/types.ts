import type { Disposable } from "../../platform/disposable";
import type { PanelHost } from "../../platform/window-service";
import type { ChatSession } from "../chat-session";
import type { CompassService } from "../compass";
import type { PermissionHandler } from "../permission-handler";
import type { IdeContextManager } from "./ide-context-manager";
import type { TerminalAttachmentManager } from "./terminal-attachment-manager";
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
  /** The webview's `ready.panelToken`, which survives a window reload; null until it arrives or when it is malformed. Every session the panel runs carries it. */
  panelToken: string | null;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  terminalAttachments: TerminalAttachmentManager;
  disposables: Disposable[];
  forkContext?: ForkContext;
  /** Resolves once the webview posts its first `ready` message; the fork replay awaits this so its
   *  extension-initiated push doesn't race the webview's listener registration. */
  webviewReady?: Promise<void>;
  /** The stored session a restore its lease refused retries once the lease turns stale; set until that retry runs. */
  restoreRetry?: string;
  /** Set up with the permissions a desktop engine restart handed back, which no restore of its conversation resets. */
  permissionsHandedBack?: true;
}

/** A settings view outside the chat page (the desktop overlay) attached to one chat panel. */
export interface AttachedView {
  /** Called from inside attachView too, with the host prompts the attach moves into this view. */
  post(message: ExtensionToWebviewMessage): void;
  /** Called once, when the panel closes, its device attaches another view in its place or a dispose detaches it. */
  detached(): void;
  /** The settings overlay tab the view serves (desktop scope tabs); absent for a local chat's overlay. */
  readonly scope?: SettingsViewScope;
  /** On a daemon's core, the device whose overlay it is: only that device's views' posts and replies reach it. */
  readonly clientId?: string;
}

export type SettingsViewScope = 'user' | 'machine' | 'project';

/**
 * A view joining a panel (views.join): what the join posts goes to the view at once. `hold` names the session whose live
 * snapshot the join captures in the same synchronous step; from then on the panel's own posts wait, and `release` delivers them
 * after the join's posts, except that session's live events numbered at or below its count at the hold.
 */
export interface ViewJoinGate {
  post(message: ExtensionToWebviewMessage): void;
  hold(session: ChatSession): void;
  release(): void;
}

export type { StoredSession, HistoryMessage, RewindHistoryItem, McpServerConfig };
