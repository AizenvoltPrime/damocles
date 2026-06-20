import * as path from 'path';

/** The values `substituteVars` expands. `env` defaults to `process.env` at the call site. */
export interface SubstitutionContext {
  workspaceFolder: string;
  userHome: string;
  env: Record<string, string | undefined>;
}

const WORKSPACE_BASENAME = (workspaceFolder: string): string =>
  workspaceFolder ? path.basename(workspaceFolder) : '';

/**
 * Expand the VS Code-style variables Claude Code hook authors rely on, in a single command token:
 * `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}`, and bare `$NAME`.
 * Missing env vars resolve to an empty string (never crash). `$NAME` only matches identifier-shaped
 * names, so shell positionals (`$1`, `$@`) pass through untouched for shell-string commands.
 */
export function substituteVars(token: string, ctx: SubstitutionContext): string {
  return token
    .replace(/\$\{workspaceFolderBasename\}/g, WORKSPACE_BASENAME(ctx.workspaceFolder))
    .replace(/\$\{workspaceFolder\}/g, ctx.workspaceFolder)
    .replace(/\$\{userHome\}/g, ctx.userHome)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => ctx.env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => ctx.env[name] ?? '');
}

/** Apply `substituteVars` across a command (string or argv array), preserving the form. */
export function substituteCommand(command: string | string[], ctx: SubstitutionContext): string | string[] {
  return Array.isArray(command)
    ? command.map((token) => substituteVars(token, ctx))
    : substituteVars(command, ctx);
}
