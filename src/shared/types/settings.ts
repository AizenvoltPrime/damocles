export type PermissionMode = "default" | "acceptEdits" | "plan";

export type ContextStrategy = "default" | "recall";

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface SandboxConfig {
  enabled: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  networkAllowedDomains?: string[];
  networkAllowLocalBinding?: boolean;
}

export interface AutoCompactConfig {
  enabled: boolean;
  warningThreshold: number;
  softThreshold: number;
  hardThreshold: number;
}

export type ContextWarningLevel = 'none' | 'warning' | 'soft' | 'critical';

export interface ProviderProfile {
  name: string;
  env: Record<string, string>;
}

export interface SessionSettings {
  model?: string;
  permissionMode: PermissionMode;
  maxThinkingTokens?: number | null;
}

export interface ExtensionSettings {
  maxTurns: number;
  maxBudgetUsd: number | null;
  maxThinkingTokens: number | null;
  thinkingDisabled: boolean;
  effort: ReasoningEffort | null;
  permissionMode: PermissionMode;
  defaultPermissionMode: PermissionMode;
  enableFileCheckpointing: boolean;
  sandbox: SandboxConfig;
  autoCompact: AutoCompactConfig;
  dangerouslySkipPermissions: boolean;
  fastMode: boolean;
}

export type FastModeState = 'off' | 'cooldown' | 'on';

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  contextWindow?: number;
  supportsEffort?: boolean;
  supportedEffortLevels?: ReasoningEffort[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  model?: string;
}

export interface BudgetWarningInfo {
  currentSpend: number;
  limit: number;
  percentUsed: number;
}
