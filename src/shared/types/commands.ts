export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
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
}

export type SlashCommandItem =
  | CustomSlashCommandInfo
  | BuiltinSlashCommandInfo
  | SkillInfo;

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "fable" | "inherit";
}

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
