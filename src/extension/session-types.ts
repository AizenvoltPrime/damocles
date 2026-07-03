import type * as vscode from 'vscode';
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

/** Options for creating a chat session. */
export interface SessionOptions {
  cwd: string;
  permissionHandler: PermissionHandler;
  onMessage: (message: ExtensionToWebviewMessage) => void;
  onSessionIdChange?: (sessionId: string | null) => void;
  onSessionPersisted?: (sessionId: string) => void;
  onAssistantTextFinal?: (text: string) => void;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  /** The workspace default model ("Default for new panels"), distinct from this panel's active model. */
  getDefaultModel?: () => string;
  memoryService?: MemoryService;
  browserService?: BrowserService;
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
  secrets?: vscode.SecretStorage;
}

/** Content input type — text string or array of content blocks (text + images). */
export type ContentInput = string | UserContentBlock[];

/** Rewind option for file/conversation restoration. */
export type RewindOption = 'fork-conversation' | 'code-only' | 'fork-and-rewind-code';
