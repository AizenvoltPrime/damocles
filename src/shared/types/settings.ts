export type PermissionMode = "default" | "acceptEdits" | "plan";

export type ContextStrategy = "default" | "distill";

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
  permissionMode: PermissionMode;
  defaultPermissionMode: PermissionMode;
  enableFileCheckpointing: boolean;
  sandbox: SandboxConfig;
  autoCompact: AutoCompactConfig;
  dangerouslySkipPermissions: boolean;
  contextStrategy: ContextStrategy;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
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
