// A design chat's least-privilege posture (PD-4, PD-25), and one writer per design file for every chat (D65), applied by the gate
// in every mode, YOLO included, and before any PreToolUse hook's force-allow, as worktree isolation is. docs/invariants.md "Design mode".
import * as path from 'node:path';
import { designBrowserAllows } from '../pi-session/tools/browser-tools';
import type { ReadOnlyVerdict } from '../pi-session/readonly-shell';
import { toolShell } from '../pi-session/worktree-isolation';
import { resolveToCwd } from '../pi-session/tools/search-tools';
import { SHELL_TOOLS, TOOL_BASH, WRITE_TOOLS } from '../../shared/tool-names';
import { BUILT_DESIGN_TOOL_NAMES } from './tools/design-tool-specs';
import { DAMOCLES_DESIGNS_DIR, isFileBelow } from '../paths';
import { spelledPath } from '../canonical-path';
import { designsFolderAllowsWrite, isDesignerFile } from './design-paths';

/** What the gate knows of a design chat, read per call. */
export type DesignScope = DesignFolderScope | UnreadableDesignScope;

/** A design chat whose role entry names its design folder. */
export interface DesignFolderScope {
  /** The design folder, the only place its write tools reach. */
  readonly folder: string;
  /** The chat's working folder, which a relative tool path resolves against. */
  readonly cwd: string;
  /** pi's `shellPath`, which the Bash tool runs its command with; undefined: bash. */
  readonly shellPath?: string;
  /** `link.json` names another chat, or cannot be read: this chat and its agents write nothing (PD-36). */
  readonly superseded?: true;
}

/** What the gate read of a call (`CallFacts` in `permission-gate.ts`), and whether it is a read-only-annotated MCP tool. */
export interface DesignCallFacts {
  readonly mcpReadOnly?: boolean;
  /** A shell call's `provenReadOnlyShell` verdict. */
  readonly shellVerdict?: ReadOnlyVerdict;
  /** A write's target may reach a network host the chat does not live on. */
  readonly reachesNetwork?: boolean;
}

/** A chat whose latest design role entry does not parse: it writes and runs nothing, reads aside, and never becomes a normal chat. */
export interface UnreadableDesignScope {
  readonly unreadable: true;
}

const DESIGNER_FILES = 'design.md, screens/<name>.html, shared/<name>.css, shared/<name>.js and files under variants/';
const DESIGN_TOOLS_WRITING = 'StartDesign, Inventory, ExtractTokens, ImportAsset, RecordDecision, MapReference, PreviewJourney, RemoveDesignFile and FinishDesign';

/** Why a design chat refuses a shell command `verdict` denies, with the classifier's reason. */
export function designShellRefusal(verdict: ReadOnlyVerdict & { readOnly: false }): string {
  return `A design chat runs only shell commands proven read-only; this one is not: ${verdict.reason}. Read files with Read (offset and limit for a range), Grep and Glob.`;
}

/**
 * The policy reason a design chat's call is blocked for, or undefined when the posture allows it: a write tool's target must be
 * a designer file of the chat's own design folder (D65), a shell command must be proven read-only, a browser tool must be a read,
 * and an unreadable scope runs no write, shell, design, page-acting browser or not read-only MCP tool. `input` is the normalized
 * input as the hooks left it; `call` holds what the gate read of it (`CallFacts`) and whether it is a read-only-annotated MCP tool. A
 * shell call without a verdict is not proven.
 */
export function designWriteBlock(toolName: string, input: Record<string, unknown>, scope: DesignScope, call: DesignCallFacts = {}): string | undefined {
  const { mcpReadOnly = false } = call;
  if ('unreadable' in scope) {
    const runs = WRITE_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName) || BUILT_DESIGN_TOOL_NAMES.has(toolName)
      || !designBrowserAllows(toolName) || (toolName.startsWith('mcp__') && !mcpReadOnly);
    return runs ? "This chat's design role cannot be read, so it writes and runs nothing; it may only read." : undefined;
  }
  if (scope.superseded && (WRITE_TOOLS.has(toolName) || BUILT_DESIGN_TOOL_NAMES.has(toolName))) {
    return 'This design continues in another design chat, so this chat no longer writes its folder or runs its design tools.';
  }
  if (WRITE_TOOLS.has(toolName)) {
    const target = input['file_path'] ?? input['path'];
    if (typeof target !== 'string' || target === '') return `A design chat writes only files in its design folder, ${scope.folder}, and this call names no file.`;
    const resolved = resolveToCwd(target, scope.cwd);
    // Resolving a target that may reach a network host would send it the user's credentials, so it counts as outside.
    if (call.reachesNetwork === true || !isFileBelow(scope.folder, resolved)) {
      return `A design chat writes only files in its design folder, ${scope.folder}. ${target} is outside it, or reaches outside it through a link.`;
    }
    // On NTFS `name:stream` writes `name`, so a stream suffix would reach another file under another spelling.
    if (path.relative(spelledPath(scope.folder), spelledPath(resolved)).includes(':')) return `A design file name has no ":"; ${target} names a file stream.`;
    if (!isDesignerFile(scope.folder, resolved)) {
      return `A design chat writes only ${DESIGNER_FILES} in its design folder, ${scope.folder}; ${target} is none of them. Damocles writes the other design files through the design tools (${DESIGN_TOOLS_WRITING}).`;
    }
    return undefined;
  }
  if (toolName === TOOL_BASH && toolShell(scope.shellPath) === undefined) {
    return `The Bash tool runs ${scope.shellPath ?? 'a shell'}, whose commands the read-only check cannot read. Use the PowerShell tool, or set shellPath to bash.`;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const verdict = call.shellVerdict ?? { readOnly: false, reason: 'no read-only verdict was taken for this command' };
    return verdict.readOnly ? undefined : designShellRefusal(verdict);
  }
  if (!designBrowserAllows(toolName)) return `A design chat may only look at pages in the browser; ${toolName} is not available to it.`;
  return undefined;
}

/**
 * The policy reason any chat's write tool (`WRITE_TOOLS`) is blocked for under one writer per design file (D65), or undefined:
 * below the designs folder it writes only a designer file of a design folder. `input` is the normalized input as the hooks left
 * it, and a relative target resolves against `cwd` as the tools resolve it.
 */
export function designFilesWriteBlock(input: Record<string, unknown>, cwd: string): string | undefined {
  const target = input['file_path'] ?? input['path'];
  if (typeof target !== 'string' || target === '' || designsFolderAllowsWrite(resolveToCwd(target, cwd))) return undefined;
  return `${target} is in the designs folder, ${DAMOCLES_DESIGNS_DIR}, whose files Damocles writes through the design tools (${DESIGN_TOOLS_WRITING}). A write tool may write only ${DESIGNER_FILES} of a design folder there.`;
}
