// The port Damocles' MCP OAuth callback server binds; main reserves the same port so no forward ever takes it.
export const DEFAULT_OAUTH_CALLBACK_PORT = 19876;

export function configuredOAuthCallbackPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MCP_OAUTH_CALLBACK_PORT'];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return DEFAULT_OAUTH_CALLBACK_PORT;
}
