import {
  TOOL_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LS,
  TOOL_BASH,
  TOOL_WRITE,
  TOOL_EDIT,
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
 * pi built-in tool name → Damocles tool display name. `find→Glob` is load-bearing: the webview's tool
 * card renderer keys off the Damocles names, not pi's. The native web tools (`WebSearch`/`WebFetch`/
 * `CodeSearch`) are already PascalCase, so they pass through `mapPiToolName` as identity — no alias.
 */
export const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: TOOL_READ,
  grep: TOOL_GREP,
  find: TOOL_GLOB,
  ls: TOOL_LS,
  bash: TOOL_BASH,
  write: TOOL_WRITE,
  edit: TOOL_EDIT,
};

/** Map a pi tool name to its Damocles display name (identity for unknown/custom names — FR-6). */
export function mapPiToolName(name: string): string {
  return PI_TOOL_NAME_MAP[name] ?? name;
}

export type ToolCategory = 'read' | 'write' | 'shell' | 'other';

/** Classify a Damocles display name. Drives gate routing (read → auto-allow; write/shell → approval). */
export function toolCategory(damoclesName: string): ToolCategory {
  if (SHELL_TOOLS.has(damoclesName)) return 'shell';
  if (WRITE_TOOLS.has(damoclesName)) return 'write';
  if (READ_ONLY_TOOLS.has(damoclesName)) return 'read';
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
 * Reverse of `normalizeToolInput`: take a CC/Damocles-shaped input (`file_path`, `-i`) and rewrite it
 * back into pi's native shape (`path`, `ignoreCase`) keyed by the pi tool name. Used for the inbound
 * `updatedInput` write-back (FR-9): a PreToolUse hook returns CC-shaped keys, but native pi tools execute
 * from their raw input, so the keys must be denormalized before they are merged onto the pi `tool_call`
 * event. The custom `Edit` tool already uses the Damocles shape, so it needs no reverse.
 */
export function denormalizeToolInput(piName: string, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  if ((piName === 'read' || piName === 'write') && 'file_path' in input) {
    input['path'] = input['file_path'];
    delete input['file_path'];
  }
  if (piName === 'grep' && '-i' in input) {
    input['ignoreCase'] = input['-i'];
    delete input['-i'];
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
