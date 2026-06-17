import {
  TOOL_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LS,
  TOOL_BASH,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_WEB_SEARCH,
  TOOL_WEB_FETCH,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  SHELL_TOOLS,
} from '../../shared/tool-names';

/**
 * Single source of truth for translating pi-native tool names + input into the Damocles
 * (Claude-Code-shaped) names + input the webview renderers and the permission gate expect.
 * Consumed by BOTH `PiStreamAdapter` (rendering) and `permission-gate` (so `canUseTool` sees
 * Damocles-shaped names/input). Keeping it here — not duplicated in each consumer — is FR-3.
 */

/**
 * pi built-in / installed-extension tool name → Damocles tool display name. `find→Glob` is
 * load-bearing: the webview's tool card renderer keys off the Damocles names, not pi's. The
 * `web_search`/`fetch_content` aliases route `pi-web-access` tools to Damocles' dedicated
 * WebSearch/WebFetch renderers (and their read-only classification).
 */
export const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: TOOL_READ,
  grep: TOOL_GREP,
  find: TOOL_GLOB,
  ls: TOOL_LS,
  bash: TOOL_BASH,
  write: TOOL_WRITE,
  edit: TOOL_EDIT,
  web_search: TOOL_WEB_SEARCH,
  fetch_content: TOOL_WEB_FETCH,
};

/** Map a pi tool name to its Damocles display name (identity for unknown/custom names — FR-6). */
export function mapPiToolName(name: string): string {
  return PI_TOOL_NAME_MAP[name] ?? name;
}

/**
 * Installed-extension tools known to be read-only, so the gate auto-allows them without a VS Code
 * fallback modal (FR-6). `code_search` is `pi-web-access`'s repo-search tool; the web aliases above
 * resolve to WebSearch/WebFetch which are already in `READ_ONLY_TOOLS`.
 */
export const EXTENSION_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  TOOL_WEB_SEARCH,
  TOOL_WEB_FETCH,
  'code_search',
]);

export type ToolCategory = 'read' | 'write' | 'shell' | 'other';

/** Classify a Damocles display name. Drives gate routing (read → auto-allow; write/shell → approval). */
export function toolCategory(damoclesName: string): ToolCategory {
  if (SHELL_TOOLS.has(damoclesName)) return 'shell';
  if (WRITE_TOOLS.has(damoclesName)) return 'write';
  if (READ_ONLY_TOOLS.has(damoclesName) || EXTENSION_READ_TOOLS.has(damoclesName)) return 'read';
  return 'other';
}

/**
 * Rewrite a pi tool's input into the Damocles shape the renderers + permission evaluator key off:
 * `read`/`write` use `path` → Damocles `file_path`; `grep` uses `ignoreCase` → Damocles `-i`. pi's
 * `find`(Glob)/`ls` already use Damocles-compatible field names. The custom `Edit` tool is registered
 * with the Damocles shape directly, so it needs no rewrite here.
 *
 * NOTE: this is for rendering + permission evaluation only. Native pi tools execute with their own
 * raw input, so the gate must NOT write a normalized copy back onto the pi `tool_call` event.
 */
export function normalizeToolInput(piName: string, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  if ((piName === 'read' || piName === 'write') && 'path' in input) {
    input['file_path'] = input['path'];
    delete input['path'];
  }
  if (piName === 'grep' && 'ignoreCase' in input) {
    input['-i'] = input['ignoreCase'];
    delete input['ignoreCase'];
  }
  return input;
}

/**
 * Translate a pi tool result's `details` into the `toolMetadata` shape the webview renderers key off.
 * pi's edit reports the first changed line as `firstChangedLine`; the Edit card reads `editLineNumber`
 * (the SDK path's name) to open the clicked file at the edit instead of the top. All other detail
 * fields (e.g. `diff`/`patch`) pass through untouched.
 */
export function normalizeToolDetails(details: Record<string, unknown>): Record<string, unknown> {
  const firstChangedLine = details['firstChangedLine'];
  if (typeof firstChangedLine === 'number' && details['editLineNumber'] === undefined) {
    return { ...details, editLineNumber: firstChangedLine };
  }
  return details;
}
