import * as os from 'node:os';
import * as path from 'node:path';
import type { McpRenamedToolRuleNotice } from '../../../shared/types/mcp';
import type { McpToolNameEntry } from './mcp-client-manager';
import { legacyMcpToolName, legacyServerPrefixMap } from './naming';
import { parseHooksFile } from '../hooks/config';
import {
  findPermissionRuleRenames,
  rewritePermissionRuleToolNames,
  type PermissionRuleRename,
} from '../../permission-handler/permission-settings';
import { JsonConfigWriteError } from '../../config/json-config-write';
import { log } from '../../logger';

/** What the legacy names of one folder's MCP tools were built from. */
export interface LegacyToolNameInput {
  /** Every server of the user-scope manager: legacy user prefixes were assigned over this set. */
  userServers: readonly string[];
  /** The user servers visible in the folder: their legacy prefixes were reserved for the folder's servers. */
  visibleUserServers: readonly string[];
  folderServers: readonly string[];
  /** Known tools of the visible user servers and of the folder's servers. */
  userTools: readonly McpToolNameEntry[];
  folderTools: readonly McpToolNameEntry[];
}

/**
 * Each known tool's legacy `mcp__<prefix>__<tool>` name mapped to its current name, for the tools
 * whose name changed (characters outside `[A-Za-z0-9_]`, or longer than 64 characters).
 */
export function legacyToCurrentToolNames(input: LegacyToolNameInput): Map<string, string> {
  const userPrefixes = legacyServerPrefixMap(input.userServers);
  const reserved = new Set(input.visibleUserServers.flatMap((name) => {
    const prefix = userPrefixes.get(name);
    return prefix === undefined ? [] : [prefix];
  }));
  const folderPrefixes = legacyServerPrefixMap(input.folderServers, reserved);
  // A legacy name that is also a current name is ambiguous, and renaming it would re-rename migrated rules.
  const currentNames = new Set([...input.userTools, ...input.folderTools].map((entry) => entry.piName));
  const renames = new Map<string, string>();
  const add = (entries: readonly McpToolNameEntry[], prefixes: Map<string, string>): void => {
    for (const entry of entries) {
      const prefix = prefixes.get(entry.serverName);
      if (prefix === undefined) continue;
      const legacy = legacyMcpToolName(prefix, entry.rawToolName);
      if (legacy !== entry.piName && !currentNames.has(legacy)) renames.set(legacy, entry.piName);
    }
  };
  add(input.userTools, userPrefixes);
  add(input.folderTools, folderPrefixes);
  return renames;
}

/**
 * Files whose permission rules Damocles rewrites: the ones it owns on this machine. The folder file is
 * confined to the repository's `.damocles`, as every other write of it is; the home files are not, as
 * `~/.damocles` may be a dotfiles symlink.
 */
export function ownedRuleFiles(folder: string | null): { path: string; confineTo?: string }[] {
  const home = os.homedir();
  return [
    { path: path.join(home, '.damocles', 'settings.json') },
    { path: path.join(home, '.damocles', 'settings.local.json') },
    ...(folder ? [{ path: path.join(folder, '.damocles', 'settings.local.json'), confineTo: path.join(folder, '.damocles') }] : []),
  ];
}

/**
 * Settings files Damocles reads rules from but never rewrites. Claude Code's files are not among them:
 * Claude Code keeps `-` in MCP tool names, so a rule there equal to a legacy Damocles name is correct for it.
 */
function noticeRuleFiles(folder: string | null): string[] {
  return folder ? [path.join(folder, '.damocles', 'settings.json')] : [];
}

/** Hook files: their matchers are patterns the user wrote, so they are listed, never rewritten. */
function hookFiles(folder: string | null): string[] {
  return [path.join(os.homedir(), '.damocles', 'hooks.json'), ...(folder ? [path.join(folder, '.damocles', 'hooks.json')] : [])];
}

const isToolNameChar = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_-]/.test(char);

/** The matcher with every legacy name that stands as a whole token renamed in one pass, the longest first. */
function renameMatcherTokens(matcher: string, legacyByLength: readonly string[], renames: ReadonlyMap<string, string>): string {
  let out = '';
  let i = 0;
  while (i < matcher.length) {
    const legacy = isToolNameChar(matcher[i - 1])
      ? undefined
      : legacyByLength.find((name) => matcher.startsWith(name, i) && !isToolNameChar(matcher[i + name.length]));
    if (legacy === undefined) {
      out += matcher[i];
      i += 1;
    } else {
      out += renames.get(legacy)!;
      i += legacy.length;
    }
  }
  return out;
}

/** Hook matchers naming a legacy tool, one entry per matcher, with the matcher text the user would edit. */
function findHookMatcherRenames(file: string, renames: ReadonlyMap<string, string>): PermissionRuleRename[] {
  const legacyByLength = [...renames.keys()].sort((a, b) => b.length - a.length);
  const found = new Map<string, string>();
  for (const entries of Object.values(parseHooksFile(file))) {
    for (const entry of entries) {
      const matcher = entry.match;
      if (typeof matcher !== 'string') continue;
      const renamed = renameMatcherTokens(matcher, legacyByLength, renames);
      if (renamed !== matcher) found.set(matcher, renamed);
    }
  }
  return [...found].map(([old, next]) => ({ old, new: next }));
}


/**
 * A file listing tool names Damocles reads but never writes: an agent definition's `disallowed_tools`,
 * or the project scope's `damocles.tools.disabled` in the repository's committed settings file.
 */
export interface ToolNameList {
  path: string;
  names: readonly string[];
}

/** The names in a list that are legacy names of renamed tools, each with its new name. */
function nameListRenames(names: readonly string[], renames: ReadonlyMap<string, string>): PermissionRuleRename[] {
  return names.flatMap((name) => {
    const current = renames.get(name);
    return current === undefined ? [] : [{ old: name, new: current }];
  });
}

/** Which notice entries were already shown, so each file and rule is shown once. */
export interface NoticeMemory {
  has(file: string, rule: string): boolean;
  add(file: string, rules: readonly string[]): Promise<void>;
}

function collapseHome(target: string): string {
  const home = os.homedir();
  return target === home || target.startsWith(home + path.sep) ? `~${target.slice(home.length).split('\\').join('/')}` : target;
}

function errorCode(err: unknown): string {
  if (err instanceof JsonConfigWriteError) return err.code ?? `${err.stage} refused`;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'no error code';
}

/**
 * Rewrite renamed MCP tool names in the permission rules of the files Damocles owns, then collect,
 * once per file and rule, the rules, hook matchers and `toolNameLists` entries in files it must not
 * rewrite. Idempotent: a rewritten rule no longer names a legacy tool, and a shown notice entry is
 * remembered.
 */
export async function migrateRenamedToolRules(
  folder: string | null,
  renames: ReadonlyMap<string, string>,
  memory: NoticeMemory,
  toolNameLists: readonly ToolNameList[] = [],
): Promise<McpRenamedToolRuleNotice[]> {
  if (renames.size === 0) return [];
  for (const file of ownedRuleFiles(folder)) {
    let rewritten: PermissionRuleRename[];
    try {
      rewritten = await rewritePermissionRuleToolNames(file.path, renames, file.confineTo !== undefined ? { confineTo: file.confineTo } : {});
    } catch (err) {
      log('[ToolNameMigration] MCP permission rules in %s were not migrated (%s)', file.path, errorCode(err));
      continue;
    }
    if (rewritten.length > 0) log('[ToolNameMigration] renamed %d MCP permission rule(s) in %s', rewritten.length, file.path);
  }

  const notices: McpRenamedToolRuleNotice[] = [];
  const collect = (file: string, found: readonly PermissionRuleRename[]): void => {
    const fresh = found.filter((rule) => !memory.has(file, rule.old));
    if (fresh.length > 0) notices.push({ path: file, displayPath: collapseHome(file), rules: fresh });
  };
  for (const file of noticeRuleFiles(folder)) collect(file, await findPermissionRuleRenames(file, renames));
  for (const file of hookFiles(folder)) collect(file, findHookMatcherRenames(file, renames));
  for (const list of toolNameLists) collect(list.path, nameListRenames(list.names, renames));
  return notices;
}
