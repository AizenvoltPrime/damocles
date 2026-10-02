import { spawn } from 'node:child_process';
import type { McpServerConfig, McpServerErrorInfo } from '../../../shared/types/mcp';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { interpolateEnvVars, killProcessTree } from './utils';

/** pi runs config commands with a 10 s timeout (`resolve-config-value.ts`). */
export const CONFIG_COMMAND_TIMEOUT_MS = 10_000;
/** execSync's default output cap, which pi's default-shell path inherits. */
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export type McpValueResolution =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string; errorInfo: McpServerErrorInfo };

export interface McpValueResolutionOptions {
  /** `pi` for pi-format sources (`pi`, `pi-project`, `damocles`, `damocles-local`), `legacy` for every other source. */
  format: 'pi' | 'legacy';
  trusted: boolean;
  /** Whether the config came from a file inside a workspace folder. */
  folderScoped: boolean;
  shellPath?: string;
  signal?: AbortSignal;
}

type TemplatePart = { type: 'literal'; value: string } | { type: 'env'; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === 'literal') {
    previous.value += value;
    return;
  }
  parts.push({ type: 'literal', value });
}

// Port of parseConfigValueTemplate in pi-coding-agent/src/core/resolve-config-value.ts.
function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf('$', index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];
    if (nextChar === '$' || nextChar === '!') {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === '{') {
      const endIndex = config.indexOf('}', dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, '$');
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: 'env', name });
      else appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: 'env', name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, '$');
    index = dollarIndex + 1;
  }
  return parts;
}

/** pi treats an empty variable as unset. */
function envValue(name: string): string | undefined {
  return process.env[name] || undefined;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    void killProcessTree(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    // ESRCH: the group already exited. This runs from a timer, so a throw would be uncaught.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') log('[McpConfigValue] Could not kill a config command: %s', (error as Error).message);
  }
}

interface CaptureResult {
  /** False when the shell itself could not be started (ENOENT, or a synchronous spawn throw), so another shell may be tried. */
  started: boolean;
  value: string | undefined;
}

/** Run a process with stdin closed or fed `input`, stderr discarded, and return its trimmed stdout when it exits 0. */
function capture(
  file: string,
  args: readonly string[],
  options: { shell: boolean; input?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ started: true, value: undefined });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        shell: options.shell,
        // POSIX gets its own process group so a timeout can kill the command's children too.
        detached: process.platform !== 'win32',
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      // Windows throws EINVAL here for a .cmd or .bat shell with shell: false; the error's spawnargs hold the command.
      resolve({ started: false, value: undefined });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: CaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    // A grandchild holding the stdout pipe delays 'close' until it exits, so a kill settles at once.
    const kill = (): void => {
      if (settled) return;
      finish({ started: true, value: undefined });
      child.stdout?.destroy();
      killTree(child.pid);
    };
    const onAbort = (): void => kill();
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        kill();
        return;
      }
      chunks.push(chunk);
    });
    if (options.input !== undefined) {
      // A shell that exits before reading its script closes this pipe; an unlistened stream error is fatal.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ started: error.code !== 'ENOENT', value: undefined });
    });
    child.once('close', (code) => {
      if (code !== 0) {
        finish({ started: true, value: undefined });
        return;
      }
      const value = Buffer.concat(chunks).toString('utf-8').trim();
      finish({ started: true, value: value || undefined });
    });
  });
}

/**
 * Run a config command (the value without its leading `!`) and return its trimmed stdout, or undefined
 * when it fails, prints nothing, times out or is aborted. On Windows it runs in pi's configured shell
 * (`getShellConfig(shellPath)`) and falls back to the default shell only when that shell cannot be
 * found or started, as pi's `executeCommandUncached` does. The output is a credential: never log it.
 */
export async function runConfigCommand(
  command: string,
  opts: { shellPath?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? CONFIG_COMMAND_TIMEOUT_MS;
  const base = { timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) };
  if (process.platform === 'win32') {
    const pi = await initPiLoader();
    const shellConfig = pi ? configuredShell(pi.getShellConfig, opts.shellPath) : undefined;
    if (shellConfig) {
      const fromStdin = shellConfig.commandTransport === 'stdin';
      const result = await capture(shellConfig.shell, fromStdin ? shellConfig.args : [...shellConfig.args, command], {
        ...base,
        shell: false,
        ...(fromStdin ? { input: command } : {}),
      });
      if (result.started) return result.value;
    }
  }
  return (await capture(command, [], { ...base, shell: true })).value;
}

type ShellConfig = { shell: string; args: string[]; commandTransport?: 'argv' | 'stdin' };

/** pi's `getShellConfig` throws when no bash is found or `shellPath` does not exist; pi then uses the default shell. */
function configuredShell(getShellConfig: (shellPath?: string) => ShellConfig, shellPath: string | undefined): ShellConfig | undefined {
  try {
    return getShellConfig(shellPath);
  } catch {
    return undefined;
  }
}

/** One expandable value of a server config, named the way errors and `errorInfo` name it. */
interface ValueField {
  field: string;
  value: string;
  set: (value: string) => void;
}

/** The expandable values of a copy of `config`, in a fixed order, with setters that write into the copy. */
function expandableFields(copy: Record<string, unknown>, format: 'pi' | 'legacy'): ValueField[] {
  const fields: ValueField[] = [];
  for (const key of ['env', 'headers'] as const) {
    const record = copy[key];
    if (!record || typeof record !== 'object') continue;
    const values: Record<string, string> = { ...(record as Record<string, string>) };
    copy[key] = values;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      fields.push({ field: `${key}.${name}`, value, set: (resolved) => { values[name] = resolved; } });
    }
  }
  if (typeof copy['bearerToken'] === 'string') {
    fields.push({ field: 'bearerToken', value: copy['bearerToken'], set: (resolved) => { copy['bearerToken'] = resolved; } });
  }
  const oauth = copy['oauth'];
  // Legacy sources never interpolated the client secret.
  if (format === 'pi' && oauth && typeof oauth === 'object') {
    const oauthCopy: Record<string, unknown> = { ...(oauth as Record<string, unknown>) };
    copy['oauth'] = oauthCopy;
    const secret = oauthCopy['clientSecret'];
    if (typeof secret === 'string') {
      fields.push({ field: 'oauth.clientSecret', value: secret, set: (resolved) => { oauthCopy['clientSecret'] = resolved; } });
    }
  }
  return fields;
}

/**
 * Refuse a value Node's spawn (NUL in `env`) or the HTTP client (line break or NUL in a header) would
 * reject, because both quote the offending value in their error, which reaches the log and the panel.
 */
function rejectUnsendable(field: string, value: string): McpValueResolution | undefined {
  if (field === 'oauth.clientSecret') return undefined;
  const forbidden = field.startsWith('env.') ? /\0/ : /[\0\r\n]/;
  if (!forbidden.test(value)) return undefined;
  const detail = `${field} resolves to a value containing a line break or NUL character`;
  return { ok: false, error: `MCP config ${detail}`, errorInfo: { code: 'invalidConfig', params: { detail } } };
}

/**
 * Expand a server's `env`, `headers`, `bearerToken` and `oauth.clientSecret` values for one connect.
 * pi-format sources follow pi's `resolveConfigValue`: a value starting with `!` is a shell command whose
 * output is the value, `$VAR`/`${VAR}` interpolate, `$$` and `$!` escape, and an unset variable or a
 * failed command fails the server. Legacy sources keep `interpolateEnvVars` and a leading `!` is literal.
 * A folder's pi-format file runs no command unless the folder is trusted. Errors name the field and
 * variable only, never a value or a command.
 */
export async function resolveMcpServerValues(
  config: McpServerConfig,
  opts: McpValueResolutionOptions,
): Promise<McpValueResolution> {
  const copy: Record<string, unknown> = { ...config };
  const fields = expandableFields(copy, opts.format);

  if (opts.format === 'legacy') {
    for (const { field, value, set } of fields) {
      const resolved = interpolateEnvVars(value);
      const rejected = rejectUnsendable(field, resolved);
      if (rejected) return rejected;
      set(resolved);
    }
    return { ok: true, config: copy as unknown as McpServerConfig };
  }

  if (opts.folderScoped && !opts.trusted) {
    const command = fields.find(({ value }) => value.startsWith('!'));
    if (command) {
      return {
        ok: false,
        error: `MCP config ${command.field} runs a command, and a folder's config runs commands only when the folder is trusted`,
        errorInfo: { code: 'commandUntrusted', params: { field: command.field } },
      };
    }
  }

  for (const { field, value, set } of fields) {
    if (value.startsWith('!')) {
      const output = await runConfigCommand(value.slice(1), {
        ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (output === undefined) {
        return {
          ok: false,
          error: `MCP config ${field}: its command failed, timed out or printed nothing`,
          errorInfo: { code: 'commandFailed', params: { field } },
        };
      }
      const rejected = rejectUnsendable(field, output);
      if (rejected) return rejected;
      set(output);
      continue;
    }
    let resolved = '';
    for (const part of parseTemplate(value)) {
      if (part.type === 'literal') {
        resolved += part.value;
        continue;
      }
      const env = envValue(part.name);
      if (env === undefined) {
        return {
          ok: false,
          error: `MCP config ${field}: environment variable ${part.name} is not set`,
          errorInfo: { code: 'missingVariable', params: { variable: part.name, field } },
        };
      }
      resolved += env;
    }
    const rejected = rejectUnsendable(field, resolved);
    if (rejected) return rejected;
    set(resolved);
  }
  return { ok: true, config: copy as unknown as McpServerConfig };
}
