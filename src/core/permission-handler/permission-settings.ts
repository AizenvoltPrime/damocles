import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { log } from "../logger";
import { writeJsonConfig } from "../config/json-config-write";
import { parseSettingsText } from "../config/settings-file";
import { TOOL_EDIT, TOOL_GENERATE_IMAGE, TOOL_READ, TOOL_WRITE } from "../../shared/tool-names";

export interface FilePermissions {
  allow: string[];
  deny: string[];
  ask: string[];
  /** The directory a `/path` rule in this file is relative to: the project folder, or the file's own directory. */
  root: string;
}

const RULE_KEYS = ["allow", "ask", "deny"] as const;

/** Tools whose rule argument is a path pattern. */
export const FILE_RULE_TOOLS: ReadonlySet<string> = new Set([TOOL_READ, TOOL_EDIT, TOOL_WRITE, TOOL_GENERATE_IMAGE]);

/** Where a file rule's pattern is anchored: the file system root, home, the settings file's root, or the cwd. */
export type RuleAnchor = "root" | "home" | "settings" | "cwd";

/**
 * A file rule's path as a gitignore pattern and its anchor, in Claude Code's four forms. An anchored
 * pattern keeps a leading `/`, so it matches only at the anchor; a cwd pattern drops a leading `./`.
 */
export function fileRulePattern(specifier: string, windows: boolean): { anchor: RuleAnchor; pattern: string } {
  if (specifier.startsWith("//")) return { anchor: "root", pattern: specifier.slice(1) };
  // Windows reads a drive path as absolute, so it is one, with `\` as a separator rather than an escape.
  if (windows && /^[A-Za-z]:[\\/]/.test(specifier)) return { anchor: "root", pattern: `/${specifier[0]!.toLowerCase()}${specifier.slice(2).replace(/\\/g, "/")}` };
  if (specifier.startsWith("~/")) return { anchor: "home", pattern: specifier.slice(1) };
  if (specifier.startsWith("/")) return { anchor: "settings", pattern: specifier };
  return { anchor: "cwd", pattern: specifier.replace(/^\.\//, "") };
}

const POSIX_CLASSES: ReadonlySet<string> = new Set(["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"]);

/**
 * Whether node-ignore compiles `pattern` into a rule that can match: it drops a blank line, a `#`
 * comment and a lone trailing `\` (`checkPattern`, `createRule`), and a pattern git gives up on, a
 * bracket expression that never closes or names an unknown class (`extractBrackets`, `scanBracket`),
 * matches nothing. Keep this in step with node-ignore's `index.js`.
 */
export function usableGitignorePattern(pattern: string): boolean {
  if (/(?:[^\\]|^)\\$/.test(pattern) || pattern.startsWith("#") || !/[^ \r\n]/.test(pattern)) return false;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "\\") {
      if (index + 1 === pattern.length || (pattern[index + 1] === "/" && index + 2 === pattern.length)) return false;
      index++;
      continue;
    }
    if (pattern[index] !== "[") continue;
    index++;
    if (pattern[index] === "!" || pattern[index] === "^") index++;
    // The first member is read before a `]` can close the expression, so a leading `]` is a member.
    let previous = "";
    for (;;) {
      const char = pattern[index];
      if (char === undefined) return false;
      if (char === "\\") {
        if (index + 1 === pattern.length) return false;
        previous = pattern[++index]!;
      } else if (char === "-" && previous && index + 1 < pattern.length && pattern[index + 1] !== "]") {
        index += pattern[index + 1] === "\\" ? 2 : 1;
        previous = "";
      } else if (char === "[" && pattern[index + 1] === ":") {
        const end = pattern.indexOf("]", index + 2);
        if (end === -1) return false;
        if (end > index + 2 && pattern[end - 1] === ":") {
          if (!POSIX_CLASSES.has(pattern.slice(index + 2, end - 1))) return false;
          index = end;
          previous = "";
        } else {
          previous = "[";
        }
      } else {
        previous = char;
      }
      index++;
      if (pattern[index] === "]") break;
    }
  }
  return true;
}

/** Why an allow rule can approve nothing, or null when it can approve something. */
function inertAllowRule(rule: string): string | null {
  const paren = rule.indexOf("(");
  const tool = paren >= 0 ? rule.slice(0, paren) : rule;
  if (tool.includes("*")) {
    return /^mcp__.+?__/.test(tool.slice(0, tool.indexOf("*"))) ? null : "has a tool-name wildcard without a literal mcp__<server>__ before it";
  }
  if (paren < 0 || !rule.endsWith(")") || !FILE_RULE_TOOLS.has(tool)) return null;
  // Claude Code never consults a `Write(path)` rule; a deny or ask one is still matched, since dropping it would fail open.
  if (tool === TOOL_WRITE) return "is a Write path rule, which Claude Code never consults (use Edit(path))";
  const specifier = rule.slice(paren + 1, -1);
  if (specifier.startsWith("!")) return "is a ! carve-out, which only a deny or ask list can hold";
  return usableGitignorePattern(fileRulePattern(specifier, process.platform === "win32").pattern) ? null : "has a path that is not a usable gitignore pattern";
}

/**
 * The string entries of one rule list. Anything else, and an allow rule that can approve nothing, is
 * dropped and logged by file and index, never by value.
 */
function ruleList(filePath: string, key: (typeof RULE_KEYS)[number], value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    log(`[PermissionSettings] ${filePath} permissions.${key} is not a list; it was skipped`);
    return [];
  }
  const rules: string[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string") {
      log(`[PermissionSettings] ${filePath} permissions.${key}[${index}] is not a string; it was skipped`);
      return;
    }
    const inert = key === "allow" ? inertAllowRule(entry) : null;
    if (inert === null) rules.push(entry);
    else log(`[PermissionSettings] ${filePath} permissions.allow[${index}] ${inert}; it was skipped`);
  });
  return rules;
}

/**
 * One settings file's permission rules, or none if it is absent, empty or unusable.
 *
 * A malformed file is logged rather than silently treated as absent. This fails OPEN — a trailing
 * comma makes every `deny` in that file vanish and the agent proceeds to ask or allow — so the one
 * signal the user gets must not be nothing. The path is logged and never the parser's message, which
 * quotes the offending source line.
 */
async function readPermissionsFromPath(filePath: string, root: string): Promise<FilePermissions> {
  const none: FilePermissions = { allow: [], deny: [], ask: [], root };
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log(`[PermissionSettings] ${filePath} could not be read (${code ?? "unknown error"}); its rules were skipped`);
    }
    return none;
  }

  let settings: Record<string, unknown>;
  try {
    settings = parseSettingsText(content, filePath);
  } catch (err) {
    log(`[PermissionSettings] ${filePath} ${err instanceof SyntaxError ? "is not valid JSON" : "does not hold a JSON object"}; its rules were skipped`);
    return none;
  }

  const perms = settings["permissions"];
  if (!perms || typeof perms !== "object") return none;

  const lists = perms as Record<string, unknown>;
  return {
    allow: ruleList(filePath, "allow", lists["allow"]),
    deny: ruleList(filePath, "deny", lists["deny"]),
    ask: ruleList(filePath, "ask", lists["ask"]),
    root,
  };
}

/**
 * Reads permission files most-specific first: `local > project > global`, and within each tier
 * `.damocles` before `.claude` (Claude Code's files are read as a courtesy, so a Damocles rule at
 * the same tier must be able to override one). With no workspace the four workspace paths drop out.
 * Files that yield no rules are omitted so an empty file cannot occupy a precedence slot.
 *
 * A `/path` rule is relative to the project folder in a project file and to the file's own directory in
 * a home file, as Claude Code resolves it to `~/.claude/path` for `~/.claude/settings.json`.
 */
export async function loadPermissionsByPriority(
  workspacePath: string | null
): Promise<FilePermissions[]> {
  const result: FilePermissions[] = [];
  const home = os.homedir();

  const project = (dir: string, file: string): { file: string; root: string } | null =>
    workspacePath ? { file: path.join(workspacePath, dir, file), root: workspacePath } : null;
  const user = (dir: string, file: string): { file: string; root: string } => ({ file: path.join(home, dir, file), root: path.join(home, dir) });
  const sources = [
    project(".damocles", "settings.local.json"),
    project(".claude", "settings.local.json"),
    project(".damocles", "settings.json"),
    project(".claude", "settings.json"),
    user(".damocles", "settings.local.json"),
    user(".claude", "settings.local.json"),
    user(".damocles", "settings.json"),
    user(".claude", "settings.json"),
  ].filter((source): source is { file: string; root: string } => source !== null);

  // Read concurrently: precedence comes from the array index below, not from completion order, so
  // eight serial round-trips on every cache miss buy nothing.
  const all = await Promise.all(sources.map((source) => readPermissionsFromPath(source.file, source.root)));

  for (const perms of all) {
    if (perms.allow.length || perms.deny.length || perms.ask.length) {
      result.push(perms);
    }
  }

  return result;
}

/** A permission rule naming a renamed tool, and the same rule under the new name. */
export interface PermissionRuleRename {
  old: string;
  new: string;
}

/** `Tool` or `Tool(argument)`: the tool part is renamed and the argument part kept as written. */
function renamedRule(rule: string, renames: ReadonlyMap<string, string>): string | undefined {
  const paren = rule.indexOf("(");
  const tool = paren >= 0 ? rule.slice(0, paren) : rule;
  const current = renames.get(tool);
  if (current === undefined) return undefined;
  return paren >= 0 ? `${current}${rule.slice(paren)}` : current;
}

function ruleRenamesIn(settings: unknown, renames: ReadonlyMap<string, string>): PermissionRuleRename[] {
  if (!settings || typeof settings !== "object") return [];
  const perms = (settings as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== "object") return [];
  const found: PermissionRuleRename[] = [];
  for (const key of RULE_KEYS) {
    const list = (perms as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (typeof rule !== "string") continue;
      const next = renamedRule(rule, renames);
      if (next !== undefined) found.push({ old: rule, new: next });
    }
  }
  return found;
}

/** The rules in one settings file that name a renamed tool. An absent or unusable file has none. */
export async function findPermissionRuleRenames(
  filePath: string,
  renames: ReadonlyMap<string, string>,
): Promise<PermissionRuleRename[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log(`[PermissionSettings] ${filePath} could not be read (${code ?? "unknown error"}); its rules were not checked for renamed tools`);
    return [];
  }
  let settings: unknown;
  try {
    settings = parseSettingsText(content, filePath);
  } catch {
    log(`[PermissionSettings] ${filePath} is not valid JSON; its rules were not checked for renamed tools`);
    return [];
  }
  return ruleRenamesIn(settings, renames);
}

/** Aborts a write whose re-read under the lock found nothing left to rename. */
class NothingToRewrite extends Error {}

/**
 * Rename tools in one Damocles-owned settings file's `allow`/`ask`/`deny` rules, keeping each rule's
 * `(…)` argument part. Runs inside the file's write critical section, re-reading it there, so it
 * cannot interleave with a rule being saved. Idempotent. Returns the rules renamed. `confineTo` is the
 * repository's own `.damocles` directory for a folder file, which a symlink must not lead out of.
 */
export async function rewritePermissionRuleToolNames(
  filePath: string,
  renames: ReadonlyMap<string, string>,
  options: { confineTo?: string } = {},
): Promise<PermissionRuleRename[]> {
  if ((await findPermissionRuleRenames(filePath, renames)).length === 0) return [];
  let rewritten: PermissionRuleRename[] = [];
  try {
    await writeJsonConfig(filePath, (current) => {
      if (current === undefined) throw new NothingToRewrite();
      let settings: Record<string, unknown>;
      try {
        settings = parseSettingsText(current, filePath);
      } catch {
        // The parser's message quotes the file, which may hold a credential.
        log(`[PermissionSettings] ${filePath} is not valid JSON; its rules were not checked for renamed tools`);
        throw new NothingToRewrite();
      }
      rewritten = ruleRenamesIn(settings, renames);
      if (rewritten.length === 0) throw new NothingToRewrite();
      const perms = settings["permissions"] as Record<string, unknown>;
      for (const key of RULE_KEYS) {
        const list = perms[key];
        if (!Array.isArray(list)) continue;
        perms[key] = list.map((rule: unknown) => (typeof rule === "string" ? (renamedRule(rule, renames) ?? rule) : rule));
      }
      return `${JSON.stringify(settings, null, 2)}\n`;
    }, options.confineTo !== undefined ? { confineTo: options.confineTo } : {});
  } catch (err) {
    if (err instanceof NothingToRewrite) return [];
    throw err;
  }
  return rewritten;
}
