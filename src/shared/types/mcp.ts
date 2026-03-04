export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export interface McpToolInfo {
  name: string;
  description?: string;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  };
}

export interface McpServerStatusInfo {
  name: string;
  displayName?: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "idle";
  enabled: boolean;
  error?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  tools?: McpToolInfo[];
}

export const CHROME_SERVER_NAME = "Chrome" as const;
export const CHROME_SDK_SERVER_NAME = "claude-in-chrome" as const;
