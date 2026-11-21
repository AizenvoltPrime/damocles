export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

/**
 * Why a listed command or skill cannot run; the view renders the reason from the code. detail: the frontmatter parser's
 * message, target: the link's readlink text, each bounded and free of control characters.
 */
export type AssetWithheld =
  | { reason: "linkOutside" | "share" | "loop" | "unreachable" | "tooLarge" | "missingDescription" | "reservedNamespace" }
  | { reason: "invalidFrontmatter"; detail: string }
  | { reason: "broken"; target: string };

/** Why a commands or skills folder itself is not read: its own link, or one above it, is not followed. */
export type RootWithheld =
  | { reason: "linkOutside" | "share" | "loop" | "unreachable" }
  | { reason: "broken"; target: string };

/** A commands or skills folder a link withholds whole: one row for the folder, never invoked; linkOutside asks for trust. */
export interface WithheldRootInfo {
  kind: "withheldRoot";
  assets: "commands" | "skills";
  /** The source's folder as spelled on disk, such as `.claude`. */
  folder: string;
  source: "project" | "user";
  filePath: string;
  untrusted?: boolean;
  withheld: RootWithheld;
}

export interface CustomSlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
  source: "project" | "user";
  /** Found but withheld from the agent because the workspace is untrusted. */
  untrusted?: boolean;
  namespace?: string;
  withheld?: AssetWithheld;
}

export interface BuiltinSlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  source: "builtin";
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  source: "project" | "user";
  /** Found but withheld from the agent because the workspace is untrusted. */
  untrusted?: boolean;
  withheld?: AssetWithheld;
}

export type SlashCommandItem =
  | CustomSlashCommandInfo
  | BuiltinSlashCommandInfo
  | SkillInfo;

/** A row of the `/` menu. */
export type SlashMenuRow = SlashCommandItem | WithheldRootInfo;

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface CustomAgentInfo {
  name: string;
  description: string;
  source: "user" | "project";
  model?: string;
  tools?: string[];
}

export interface WorkspaceFileInfo {
  relativePath: string;
  isDirectory: boolean;
}

export type AtMentionItem =
  | { type: "file"; data: WorkspaceFileInfo }
  | { type: "builtin-agent"; data: AgentConfig }
  | { type: "custom-agent"; data: CustomAgentInfo };

export const AVAILABLE_AGENTS: AgentConfig[] = [
  { id: "general-purpose", name: "General Purpose", description: "General-purpose coding assistant", icon: "🤖" },
  { id: "statusline-setup", name: "Statusline Setup", description: "Configure status line settings", icon: "⚙️" },
  { id: "Explore", name: "Explore", description: "Fast codebase exploration", icon: "🗺️" },
  { id: "Plan", name: "Plan", description: "Software architecture planning", icon: "📋" },
  { id: "claude-code-guide", name: "Claude Code Guide", description: "Help with Claude Code usage", icon: "📖" },
];
