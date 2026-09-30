import type { SecretsStore } from '../platform/secrets-store';
import type { Platform } from '../platform/platform';
import type { PanelHost } from '../platform/window-service';
import type { PermissionHandler } from './permission-handler';
import type { ExtensionToWebviewMessage } from '../shared/types/messages';
import type { McpServerConfig } from '../shared/types/mcp';
import type { UserContentBlock } from '../shared/types/content';
import type { EffortLevel } from '../shared/types/settings';
import type { MemoryService } from './memory';
import type { BrowserService } from './browser';
import type { TeamService } from './team';
import type { CompassService } from './compass';
import type { ForkContext, ForkSpawnArgs } from '../shared/types/session';

/** MCP servers one panel may use, split by scope so user-scope servers share one connection window-wide. */
export interface McpScope {
  /** Enabled user-scope servers visible in at least one open folder; fed to the one process-wide user manager. */
  userUnion: Record<string, McpServerConfig>;
  /** Keys of `userUnion` visible in this panel's folder (not shadowed by a folder-scope entry there). */
  userVisible: string[];
  /** This folder's enabled, trust-permitted folder-scope servers. */
  folder: Record<string, McpServerConfig>;
}

/** Options for creating a chat session. */
export interface SessionOptions {
  cwd: string;
  platform: Platform;
  permissionHandler: PermissionHandler;
  onMessage: (message: ExtensionToWebviewMessage) => void;
  /** `stored`: the session already has its file on disk (a resumed or forked one); a new one gets it with its first reply. */
  onSessionIdChange?: (sessionId: string | null, stored: boolean) => void;
  onSessionPersisted?: (sessionId: string) => void;
  onAssistantTextFinal?: (text: string) => void;
  mcpScope?: McpScope;
  model?: string;
  /** The workspace default model ("Default for new panels"), distinct from this panel's active model. */
  getDefaultModel?: () => string;
  memoryService?: MemoryService;
  browserService?: BrowserService;
  /** The chat panel this session runs in; its agents' browser pages belong to it. */
  browserChat?: PanelHost;
  panelId?: string;
  teamService?: TeamService;
  compassService?: CompassService;
  onSpawnFork?: (args: ForkSpawnArgs) => Promise<void>;
  forkContext?: ForkContext;
  resolveThinking: (model: string) => {
    thinkingDisabled: boolean;
    effort: EffortLevel | null;
    maxThinkingTokens: number | null;
  };
  /** Whether to prefer the OpenAI API key over Codex OAuth when both are configured (pi path). */
  getPreferOpenAIApiKey?: () => boolean;
  secrets?: SecretsStore;
}

/** Content input type — text string or array of content blocks (text + images). */
export type ContentInput = string | UserContentBlock[];

/** Rewind option for file/conversation restoration. */
export type RewindOption = 'fork-conversation' | 'code-only' | 'fork-and-rewind-code';
