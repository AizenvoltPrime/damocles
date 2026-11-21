import * as path from "path";
import * as os from "os";
import { log } from "../logger";
import { writeJsonConfig } from "../config/json-config-write";
import { personalConfigRoot } from "../worktrees/personal-config";
import { parseSettingsText } from "../config/settings-file";
import { userConfigBase, type ConfigNotices } from "../config/local-config-path";
import { folderKey } from "../workspace-folders/folder-key";
import { englishText, LocalizedError, type LocalizedText } from "../../shared/localized-text";
import { TOOL_EDIT, TOOL_GENERATE_IMAGE, TOOL_READ, TOOL_WEB_FETCH, TOOL_WRITE } from "../../shared/tool-names";
import { inertMcpSpecifierRule } from "./mcp-resource-rule";
import { inertWebFetchAllowSpecifier } from "./web-fetch-rule";
import { keptRulesText, readRuleFileText, unreadableRulesText } from "./rule-file-read";
import type { ClientUser } from "../../shared/remote-user";
import type { UnreadableRuleFile } from "../../shared/types/permissions";

export interface FilePermissions {
  allow: string[];
  deny: string[];
  ask: string[];
  /** The directory a `/path` rule in this file is relative to: the project folder, or the file's own directory. */
  root: string;
}

/** The folder whose project files are read, and whether its personal files are too (personalFilesTrusted). */
export interface PermissionWorkspace {
  readonly path: string;
  readonly personalFiles: boolean;
}

/** A settings file whose rules are read: root anchors its `/path` rules, baseFolder is its scope root (checkConfigPath). */
interface RuleSource {
  readonly file: string;
  readonly root: string;
  readonly baseFolder: string;
}

/** What one rules file's reads gave: the rules of its last successful read (a missing file has none), and whether its latest read failed. */
export interface RuleFileRecord {
  readonly lastGood: FilePermissions | undefined;
  readonly failing: boolean;
}

/** Each rules file's record, by `folderKey` of its path; one EvaluatorManager owns it for its lifetime. */
export type RuleFileRecords = Map<string, RuleFileRecord>;

/** The rules that apply, or the first rules file, by precedence, whose rules cannot be known. */
export type LoadedPermissions = { readonly files: FilePermissions[] } | { readonly unreadable: UnreadableRuleFile };

/** Which settings rules apply cannot be known, so no rule lookup answers: the gate blocks the call with this text. */
export class PermissionRulesUnreadable extends LocalizedError {
  readonly file: string;

  constructor({ file, reason }: UnreadableRuleFile) {
    super(unreadableRulesText(file, reason));
    this.name = "PermissionRulesUnreadable";
    this.file = file;
  }
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
  if (paren >= 0 && rule.endsWith(")") && tool === TOOL_WEB_FETCH) return inertWebFetchAllowSpecifier(rule.slice(paren + 1, -1));
  if (paren < 0 || !rule.endsWith(")") || !FILE_RULE_TOOLS.has(tool)) return null;
  // Claude Code never consults a `Write(path)` rule; a deny or ask one is still matched, since dropping it would fail open.
  if (tool === TOOL_WRITE) return "is a Write path rule, which Claude Code never consults (use Edit(path))";
  const specifier = rule.slice(paren + 1, -1);
  if (specifier.startsWith("!")) return "is a ! carve-out, which only a deny or ask list can hold";
  return usableGitignorePattern(fileRulePattern(specifier, process.platform === "win32").pattern) ? null : "has a path that is not a usable gitignore pattern";
}

/**
 * The string entries of one rule list. Anything else, an allow rule that can approve nothing, and an
 * `mcp__` rule whose parentheses no tool takes, is dropped and logged by file and index, never by value.
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
    const inert = (key === "allow" ? inertAllowRule(entry) : null) ?? inertMcpSpecifierRule(entry);
    if (inert === null) rules.push(entry);
    else log(`[PermissionSettings] ${filePath} permissions.${key}[${index}] ${inert}; it was skipped`);
  });
  return rules;
}

/**
 * One settings file's permission rules, or none if it is absent, empty or unusable; a file that cannot be checked or read gives
 * the rules of its last successful read in `records`, else its unreadable outcome. The user gets a notice each time the file
 * starts failing.
 */
async function readPermissionsFromPath(source: RuleSource, records: RuleFileRecords, notifications: ConfigNotices | undefined): Promise<FilePermissions | UnreadableRuleFile> {
  const { file: filePath, root } = source;
  const read = await readRuleFileText(filePath, source.baseFolder);
  if ("unreadable" in read) return failedRead(source, read.unreadable, records, notifications);
  const rules = "missing" in read ? { allow: [], deny: [], ask: [], root } : permissionsOf(filePath, read.text, root);
  records.set(folderKey(filePath), { lastGood: rules, failing: false });
  return rules;
}

// The record is read and written with no await between, so concurrent loads give one notice per failing spell.
function failedRead(source: RuleSource, reason: LocalizedText, records: RuleFileRecords, notifications: ConfigNotices | undefined): FilePermissions | UnreadableRuleFile {
  const { file, root } = source;
  const key = folderKey(file);
  const record = records.get(key);
  // A personal file is one path for a project and its worktrees, so its `/path` rules anchor at this load's folder.
  const lastGood = record?.lastGood && { ...record.lastGood, root };
  log(`[PermissionSettings] ${file} could not be read (${englishText(reason)}); ${lastGood ? "the rules it last read apply" : "it was never read, so the rules cannot be known"}`);
  if (record?.failing !== true) {
    void notifications?.warn(lastGood ? keptRulesText(file, reason) : unreadableRulesText(file, reason));
  }
  records.set(key, { lastGood, failing: true });
  return lastGood ?? { file, reason };
}

/**
 * The permission rules in a settings file's text.
 *
 * A malformed file is logged rather than silently treated as absent. This fails OPEN — a trailing
 * comma makes every `deny` in that file vanish and the agent proceeds to ask or allow — so the one
 * signal the user gets must not be nothing. The path is logged and never the parser's message, which
 * quotes the offending source line.
 */
function permissionsOf(filePath: string, content: string, root: string): FilePermissions {
  const none: FilePermissions = { allow: [], deny: [], ask: [], root };
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
 * the same tier must be able to override one). With no workspace the four workspace paths drop out, and
 * without `personalFiles` the two `settings.local.json` ones.
 * Files that yield no rules are omitted so an empty file cannot occupy a precedence slot.
 *
 * A `/path` rule is relative to the project folder in a project file and to the file's own directory in
 * a home file, as Claude Code resolves it to `~/.claude/path` for `~/.claude/settings.json`.
 *
 * On a daemon's core the home files are its host's (machine scope), and `client`, the pinned client's clientUser, gives
 * its user files' rules (one entry per file), which come last; rules combine as deny > ask > allow, so a host file never
 * lifts a client's deny.
 *
 * `records` keeps each file's last successful read; a file that cannot be checked or read and has none makes the whole result
 * unreadable, since its deny and ask rules may be the ones that apply, and so does a client file the client marks so.
 */
export async function loadPermissionsByPriority(
  workspace: PermissionWorkspace | null,
  records: RuleFileRecords,
  client?: Pick<ClientUser, "permissionRules" | "unreadable">,
  notifications?: ConfigNotices,
): Promise<LoadedPermissions> {
  const result: FilePermissions[] = [];
  const home = os.homedir();
  const workspacePath = workspace?.path ?? null;

  const project = (dir: string, file: string): RuleSource | null =>
    workspacePath ? { file: path.join(workspacePath, dir, file), root: workspacePath, baseFolder: workspacePath } : null;
  // D34: a worktree chat's personal files are its project's, live; relative rule paths still match the working folder.
  const personalRoot = workspacePath && workspace?.personalFiles === true ? personalConfigRoot(workspacePath) : null;
  const personal = (dir: string, file: string): RuleSource | null =>
    personalRoot && workspacePath ? { file: path.join(personalRoot, dir, file), root: workspacePath, baseFolder: personalRoot } : null;
  const user = (dir: string, file: string): RuleSource => ({ file: path.join(home, dir, file), root: path.join(home, dir), baseFolder: userConfigBase(path.join(home, dir, file)) });
  const sources = [
    personal(".damocles", "settings.local.json"),
    personal(".claude", "settings.local.json"),
    project(".damocles", "settings.json"),
    project(".claude", "settings.json"),
    user(".damocles", "settings.local.json"),
    user(".claude", "settings.local.json"),
    user(".damocles", "settings.json"),
    user(".claude", "settings.json"),
  ].filter((source): source is RuleSource => source !== null);

  // Read concurrently: precedence comes from the array index below, not from completion order, so
  // eight serial round-trips on every cache miss buy nothing.
  const read = await Promise.all(sources.map((source) => readPermissionsFromPath(source, records, notifications)));
  const unreadable = read.find((perms): perms is UnreadableRuleFile => "reason" in perms) ?? client?.unreadable;
  if (unreadable !== undefined) return { unreadable };
  const all = read.filter((perms): perms is FilePermissions => !("reason" in perms));

  // a client file's `/path` rules name a folder of the client's home, which this host lacks, so they anchor at this host's same folder
  client?.permissionRules.forEach((rules, index) => {
    const label = `the client's user settings file ${index + 1}`;
    all.push({ allow: ruleList(label, "allow", rules.allow), deny: ruleList(label, "deny", rules.deny), ask: ruleList(label, "ask", rules.ask), root: path.join(home, rules.dir) });
  });
  for (const perms of all) {
    if (perms.allow.length || perms.deny.length || perms.ask.length) {
      result.push(perms);
    }
  }

  return { files: result };
}

/** A permission rule naming a renamed tool, and the same rule under the new name. */
export interface PermissionRuleRename {
  old: string;
  new: string;
}

/**
 * `Tool` or `Tool(argument)`: the tool part is renamed and the argument part kept as written. A
 * replacement that is a name plus its own `(…)` specifier replaces a bare rule only.
 */
function renamedRule(rule: string, renames: ReadonlyMap<string, string>): string | undefined {
  const paren = rule.indexOf("(");
  const tool = paren >= 0 ? rule.slice(0, paren) : rule;
  const current = renames.get(tool);
  if (current === undefined) return undefined;
  if (paren < 0) return current;
  // A tool name never holds `(`; such a replacement names one resource, and the old rule's argument has no place in it.
  return current.includes("(") ? undefined : `${current}${rule.slice(paren)}`;
}

/** Rules to insert right after a rule of one list, so the list keeps covering what that rule covered. */
export type PermissionRuleAdditions = (rule: string, list: (typeof RULE_KEYS)[number]) => readonly string[];

/**
 * One list with its renames applied and its additions inserted, plus what changed. A renamed or added rule
 * already in the list, as written or produced earlier, is not written again; the list's own duplicates stay.
 */
function updatedRuleList(
  list: readonly unknown[],
  key: (typeof RULE_KEYS)[number],
  renames: ReadonlyMap<string, string>,
  additions: PermissionRuleAdditions | undefined,
): { list: unknown[]; changes: PermissionRuleRename[] } {
  const present = new Set(list.filter((rule): rule is string => typeof rule === "string"));
  const next: unknown[] = [];
  const changes: PermissionRuleRename[] = [];
  for (const rule of list) {
    if (typeof rule !== "string") {
      next.push(rule);
      continue;
    }
    const renamed = renamedRule(rule, renames);
    const kept = renamed ?? rule;
    if (renamed === undefined || !present.has(renamed)) next.push(kept);
    present.add(kept);
    const added: string[] = [];
    for (const extra of additions?.(rule, key) ?? []) {
      if (present.has(extra)) continue;
      present.add(extra);
      added.push(extra);
      next.push(extra);
    }
    if (renamed !== undefined || added.length > 0) changes.push({ old: rule, new: [kept, ...added].join(", ") });
  }
  return { list: next, changes };
}

function ruleRenamesIn(settings: unknown, renames: ReadonlyMap<string, string>, additions?: PermissionRuleAdditions): PermissionRuleRename[] {
  if (!settings || typeof settings !== "object") return [];
  const perms = (settings as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== "object") return [];
  const found: PermissionRuleRename[] = [];
  for (const key of RULE_KEYS) {
    const list = (perms as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    found.push(...updatedRuleList(list, key, renames, additions).changes);
  }
  return found;
}

/** A settings file that exists but could not be checked or read (readRuleFileText), so its rules are not known. */
export class RuleFileUnreadable extends Error {
  readonly file: string;
  readonly reason: LocalizedText;

  constructor(file: string, reason: LocalizedText) {
    super(`${file} could not be read (${englishText(reason)})`);
    this.name = "RuleFileUnreadable";
    this.file = file;
    this.reason = reason;
  }
}

/**
 * The rules in one settings file that name a renamed tool or take an addition. An absent or unusable file has none; one that
 * cannot be checked or read, a link off its scope root's share (baseFolder) included, throws RuleFileUnreadable.
 */
export async function findPermissionRuleRenames(
  filePath: string,
  baseFolder: string,
  renames: ReadonlyMap<string, string>,
  additions?: PermissionRuleAdditions,
): Promise<PermissionRuleRename[]> {
  const read = await readRuleFileText(filePath, baseFolder);
  if ("missing" in read) return [];
  if ("unreadable" in read) throw new RuleFileUnreadable(filePath, read.unreadable);
  let settings: unknown;
  try {
    settings = parseSettingsText(read.text, filePath);
  } catch {
    log(`[PermissionSettings] ${filePath} is not valid JSON; its rules were not checked for renamed tools`);
    return [];
  }
  return ruleRenamesIn(settings, renames, additions);
}

/** Aborts a write whose re-read under the lock found nothing left to rename. */
class NothingToRewrite extends Error {}

/** A write its trust re-check refused inside the write's critical section; nothing was changed. */
export class RuleFileNotWritable extends Error {
  constructor(file: string) {
    super(`${file} may no longer be written`);
    this.name = "RuleFileNotWritable";
  }
}

/**
 * Rename tools in one Damocles-owned settings file's `allow`/`ask`/`deny` rules, keeping each rule's
 * `(…)` argument part, and insert each rule's `additions` after it. Runs inside the file's write
 * critical section, re-reading it there, so it cannot interleave with a rule being saved. Idempotent.
 * Returns the rules changed. `confineTo` is the repository's own `.damocles` directory for a folder
 * file, which a symlink must not lead out of; `baseFolder` is the file's scope root (checkConfigPath).
 * `writable`, read inside the critical section, throws RuleFileNotWritable with nothing changed when it answers false.
 */
export async function rewritePermissionRuleToolNames(
  filePath: string,
  renames: ReadonlyMap<string, string>,
  options: { baseFolder: string; confineTo?: string; additions?: PermissionRuleAdditions; writable?: () => boolean },
): Promise<PermissionRuleRename[]> {
  const { additions, baseFolder } = options;
  if ((await findPermissionRuleRenames(filePath, baseFolder, renames, additions)).length === 0) return [];
  let rewritten: PermissionRuleRename[] = [];
  try {
    await writeJsonConfig(filePath, (current) => {
      if (current === undefined) throw new NothingToRewrite();
      if (options.writable?.() === false) throw new RuleFileNotWritable(filePath);
      let settings: Record<string, unknown>;
      try {
        settings = parseSettingsText(current, filePath);
      } catch {
        // The parser's message quotes the file, which may hold a credential.
        log(`[PermissionSettings] ${filePath} is not valid JSON; its rules were not checked for renamed tools`);
        throw new NothingToRewrite();
      }
      rewritten = ruleRenamesIn(settings, renames, additions);
      if (rewritten.length === 0) throw new NothingToRewrite();
      const perms = settings["permissions"] as Record<string, unknown>;
      for (const key of RULE_KEYS) {
        const list = perms[key];
        if (!Array.isArray(list)) continue;
        perms[key] = updatedRuleList(list, key, renames, additions).list;
      }
      return `${JSON.stringify(settings, null, 2)}\n`;
    }, options.confineTo !== undefined ? { confineTo: options.confineTo, baseFolder } : { baseFolder });
  } catch (err) {
    if (err instanceof NothingToRewrite) return [];
    throw err;
  }
  return rewritten;
}
