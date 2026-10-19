import * as os from 'node:os';
import * as path from 'node:path';
import { renamedRuleNoticeKey, type McpRenamedToolRuleLocation, type McpRenamedToolRuleNotice } from '../../../shared/types/mcp';
import { personalConfigRoot } from '../../worktrees/personal-config';
import type { McpToolNameEntry, RetiredResourceEntry } from './mcp-client-manager';
import { assignServerToolNames, createMcpToolName, legacyMcpToolName, legacyServerPrefixMap, MCP_TOOL_PREFIX } from './naming';
import { READ_MCP_RESOURCE } from '../../permission-handler/mcp-resource-rule';
import { matchesMcpRule, mcpRuleSplits } from '../../permission-handler/managers/evaluator-manager';
import { matchesToolPattern } from './exposure';
import { t } from '../../l10n';
import { parseHooksFile } from '../hooks/config';
import { compileMatch } from '../hooks/dispatch';
import {
  findPermissionRuleRenames,
  rewritePermissionRuleToolNames,
  type PermissionRuleAdditions,
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
  /**
   * Per manager, each enabled server whose tools are known, with the resources older builds cached for it.
   * The user manager's cover all its servers, visible here or not: older builds named them together.
   */
  retiredResources: { user: readonly RetiredResourceEntry[]; folder: readonly RetiredResourceEntry[] };
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

/** A resource name as the `<slug>` of the retired `get_<slug>` tool older builds made for it. */
export function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .toLowerCase();
  if (!result || /^\d/.test(result)) {
    result = 'resource' + (result ? '_' + result : '');
  }
  return result;
}

/** The resource a retired `get_<slug>` tool read, and the names that tool had. */
export interface RetiredResourceTool {
  server: string;
  uri: string;
  /** `get_<slug>`, the tool part of its permission identity. */
  rawName: string;
  /** Its pi name. */
  piName: string;
  /** Whether a user-scope server offered it; a folder server's URI is that folder's. */
  userServer: boolean;
}

/** One name an older build assigned in a manager: a server's tool, or the `get_<slug>` tool of a resource. */
interface AssignedName {
  server: string;
  piName: string;
  resource?: { uri: string; rawName: string };
}

/**
 * One manager's names as older builds assigned them (`McpClientManager.rebuildDescriptors`, git 054af512 to 6790cdf6):
 * servers in sorted order, each server's tools then its resources' `get_<slug>` tools named together by
 * `assignServerToolNames` with `reserved` and every earlier server's names taken, and the first holder of a
 * name keeping it, so a tool wins over a resource of the same raw name and the first resource of a slug wins.
 */
function assignedNames(entries: readonly RetiredResourceEntry[], reserved: ReadonlySet<string>): AssignedName[] {
  const byServer = new Map(entries.map((entry) => [entry.serverName, entry]));
  const taken = new Set(reserved);
  const held = new Set<string>();
  const names: AssignedName[] = [];
  for (const server of [...byServer.keys()].sort()) {
    const entry = byServer.get(server)!;
    const resources = entry.resources.map((resource) => ({ uri: resource.uri, rawName: `get_${resourceNameToToolName(resource.name)}` }));
    const assigned = assignServerToolNames(server, [...entry.rawToolNames, ...resources.map((resource) => resource.rawName)], taken);
    const hold = (piName: string, resource?: AssignedName['resource']): void => {
      if (held.has(piName)) return;
      held.add(piName);
      taken.add(piName);
      names.push({ server, piName, ...(resource ? { resource } : {}) });
    };
    for (const tool of entry.rawToolNames) hold(assigned.get(tool)!);
    for (const resource of resources) hold(assigned.get(resource.rawName)!, resource);
  }
  return names;
}

/**
 * Each name a rule could give a retired resource tool, mapped to the tools it named, replayed as older
 * builds assigned them: the user manager over all its servers, then the folder manager with the names of
 * the user servers visible here reserved. Besides the pi name, a rule could name the tool with the server
 * as written or as Claude Code spells it, so both spellings map too, and one spelling can name tools of
 * two servers. A name that a tool holds now or held then is left alone, as `legacyToCurrentToolNames`
 * leaves one.
 */
export function retiredResourceToolNames(input: LegacyToolNameInput): Map<string, RetiredResourceTool[]> {
  const visible = new Set(input.visibleUserServers);
  const user = assignedNames(input.retiredResources.user, new Set()).filter((name) => visible.has(name.server));
  const folder = assignedNames(input.retiredResources.folder, new Set(user.map((name) => name.piName)));
  const currentNames = new Set([...input.userTools, ...input.folderTools].map((entry) => entry.piName));
  for (const name of [...user, ...folder]) if (!name.resource) currentNames.add(name.piName);
  const tools: RetiredResourceTool[] = [
    ...user.map((name) => ({ name, userServer: true })),
    ...folder.map((name) => ({ name, userServer: false })),
  ].flatMap(({ name: { server, piName, resource }, userServer }) => (resource ? [{ server, uri: resource.uri, rawName: resource.rawName, piName, userServer }] : []));
  // Pi names first, so a name that is one tool's pi name and another's other spelling names that tool first.
  const retired = new Map<string, RetiredResourceTool[]>();
  const claim = (name: string, tool: RetiredResourceTool): void => {
    if (currentNames.has(name)) return;
    const claimants = retired.get(name) ?? [];
    if (!claimants.includes(tool)) retired.set(name, [...claimants, tool]);
  };
  for (const tool of tools) claim(tool.piName, tool);
  for (const tool of tools) {
    claim(`${MCP_TOOL_PREFIX}${tool.server}__${tool.rawName}`, tool);
    claim(`${MCP_TOOL_PREFIX}${tool.server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool.rawName}`, tool);
  }
  return retired;
}

/** The rule that keeps a retired resource tool's rule on the same resource. */
export function resourceRuleFor(resource: Pick<RetiredResourceTool, 'server' | 'uri'>): string {
  return `${createMcpToolName(resource.server, READ_MCP_RESOURCE)}(${resource.uri})`;
}

/** What each old name becomes in one kind of place, per kind of entry that names it. */
export interface RenameSet {
  /** Permission rules: a renamed tool's new name, or a retired resource tool's name plus URI specifier. */
  rules: ReadonlyMap<string, string>;
  /** Hook matchers cannot carry a URI; they match a resource call through its server identity. */
  matchers: ReadonlyMap<string, string>;
  /**
   * Exact-name lists Damocles does not own (`disallowed_tools`, the project's `damocles.tools.disabled`), which
   * matched pi names only: a renamed tool's new name, or a retired resource tool's URI-scoped entry.
   */
  names: ReadonlyMap<string, string>;
  /** The retired resource tools' entries of `rules`, for files whose legacy names are correct as written. */
  retiredRules: ReadonlyMap<string, string>;
  /**
   * Each retired resource tool's pi name, the one spelling an exact-name list entry ever matched, mapped to
   * the URI-scoped entry that turns the same resource off.
   */
  retiredListEntries: ReadonlyMap<string, string>;
  /** For a deny or ask rule that covered a retired resource tool but not a read of that resource, the rules keeping that coverage. */
  ruleAdditions: PermissionRuleAdditions;
  /** One entry per retired resource tool. */
  retiredTools: readonly RetiredResourceTool[];
}

export interface ToolRenames extends RenameSet {
  /**
   * The renames for places every folder shares: the home settings files and the personal scopes'
   * `damocles.tools.disabled`. A folder server's retired tool stays out, because its URI is this folder's.
   */
  shared: RenameSet;
}

/** The prefix of every retired resource tool's raw name. */
const RETIRED_TOOL_PREFIX = 'get_';

/**
 * The rules a deny or ask `mcp__` glob needs beside it for each retired resource tool it matched under that
 * tool's identity and no longer matches as a resource read on the same server. Where its tool part matched
 * every `get_` name, it covered every resource of the servers its server part names, so one
 * `mcp__<server part>__read_mcp_resource` keeps that, for any folder. A narrower glob singled out resources by
 * name, so each gets its URI-scoped rule, for `uriTools` only. An allow needs none, since a resource read runs unasked.
 */
function globRuleAdditions(retiredTools: readonly RetiredResourceTool[], uriTools: ReadonlySet<RetiredResourceTool>): PermissionRuleAdditions {
  return (rule, list) => {
    if (list === 'allow' || !rule.startsWith(MCP_TOOL_PREFIX) || !rule.includes('*') || rule.includes('(') || rule.includes(')')) return [];
    const added = new Set<string>();
    for (const tool of retiredTools) {
      const identity = { server: tool.server, tool: tool.rawName };
      if (!matchesMcpRule(rule, tool.piName, identity)) continue;
      if (matchesMcpRule(rule, READ_MCP_RESOURCE, { server: tool.server, tool: READ_MCP_RESOURCE })) continue;
      const everyResource = mcpRuleSplits(rule, identity).filter((split) => split.tool.endsWith('*') && matchesToolPattern(split.tool, RETIRED_TOOL_PREFIX));
      for (const split of everyResource) added.add(`${MCP_TOOL_PREFIX}${split.server}__${READ_MCP_RESOURCE}`);
      if (everyResource.length === 0 && uriTools.has(tool)) added.add(resourceRuleFor(tool));
    }
    return [...added];
  };
}

/** One kind of place's renames, from the retired spellings it may rewrite. */
function renameSet(
  legacy: ReadonlyMap<string, string>,
  retired: ReadonlyMap<string, readonly RetiredResourceTool[]>,
  allRetiredTools: readonly RetiredResourceTool[],
): RenameSet {
  const rules = new Map<string, string>();
  const matchers = new Map<string, string>();
  const retiredListEntries = new Map<string, string>();
  const sharedSpellings = new Map<string, string[]>();
  for (const [former, [first, ...others]] of retired) {
    if (!first) continue;
    rules.set(former, resourceRuleFor(first));
    matchers.set(former, createMcpToolName(first.server, READ_MCP_RESOURCE));
    if (others.length > 0) sharedSpellings.set(former, others.map(resourceRuleFor));
    const owner = [first, ...others].find((tool) => tool.piName === former);
    if (owner) retiredListEntries.set(former, resourceRuleFor(owner));
  }
  const retiredRules = new Map(rules);
  for (const map of [rules, matchers]) for (const [old, current] of legacy) map.set(old, current);
  const names = new Map([...retiredListEntries, ...legacy]);
  const retiredTools = [...new Set([...retired.values()].flat())];
  const globs = globRuleAdditions(allRetiredTools, new Set(retiredTools));
  const ruleAdditions: PermissionRuleAdditions = (rule, list) =>
    list !== 'allow' && !legacy.has(rule) && sharedSpellings.has(rule) ? sharedSpellings.get(rule)! : globs(rule, list);
  return { rules, matchers, names, retiredRules, retiredListEntries, ruleAdditions, retiredTools };
}

/**
 * Combine both rename sources; a legacy rename wins over a retired name it shares. A deny or ask rule
 * naming a spelling that several retired tools had becomes the first tool's rule, and gains the others'.
 * In shared places a spelling any folder server's tool had is left for the notice.
 */
export function toolRenames(legacy: ReadonlyMap<string, string>, retired: ReadonlyMap<string, readonly RetiredResourceTool[]>): ToolRenames {
  const allRetiredTools = [...new Set([...retired.values()].flat())];
  const userOnly = new Map([...retired].filter(([, tools]) => tools.every((tool) => tool.userServer)));
  return { ...renameSet(legacy, retired, allRetiredTools), shared: renameSet(legacy, userOnly, allRetiredTools) };
}

/**
 * Files whose permission rules Damocles rewrites: the ones it owns on this machine. The folder file is
 * confined to the repository's `.damocles`, as every other write of it is; the home files are not, as
 * `~/.damocles` may be a dotfiles symlink. A file is `shared` when other folders read it too: the home
 * files, and a chat worktree's personal file, which is its project's (D34).
 */
export function ownedRuleFiles(folder: string | null): { path: string; confineTo?: string; shared: boolean }[] {
  const home = os.homedir();
  const personal = folder === null ? null : personalConfigRoot(folder);
  return [
    { path: path.join(home, '.damocles', 'settings.json'), shared: true },
    { path: path.join(home, '.damocles', 'settings.local.json'), shared: true },
    ...(folder !== null && personal !== null
      ? [{ path: path.join(personal, '.damocles', 'settings.local.json'), confineTo: path.join(personal, '.damocles'), shared: personal !== folder }]
      : []),
  ];
}

/**
 * Settings files Damocles reads rules from but never rewrites. Claude Code's files are not among them:
 * Claude Code keeps `-` in MCP tool names, so a rule there equal to a legacy Damocles name is correct for it.
 */
function noticeRuleFiles(folder: string | null): string[] {
  return folder ? [path.join(folder, '.damocles', 'settings.json')] : [];
}

/** Claude Code's settings files, checked for retired resource tools only: Claude Code never had those, so such a rule was written for Damocles. */
function claudeRuleFiles(folder: string | null): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    ...(folder ? [path.join(folder, '.claude', 'settings.json'), path.join(personalConfigRoot(folder), '.claude', 'settings.local.json')] : []),
  ];
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

/**
 * A matcher that is a pattern rather than a name: the resource read names it matches a retired resource
 * tool through and no longer reaches, to append as alternatives.
 */
function lostResourceMatches(matcher: string, retiredTools: readonly RetiredResourceTool[]): string[] {
  const regex = compileMatch(matcher);
  if (!regex) return [];
  const lost = new Set<string>();
  for (const tool of retiredTools) {
    const readName = createMcpToolName(tool.server, READ_MCP_RESOURCE);
    if (regex.test(tool.piName) && !regex.test(readName)) lost.add(readName);
  }
  return [...lost];
}

/** Hook matchers naming a legacy or retired tool, one entry per matcher, with the matcher text the user would edit. */
function findHookMatcherRenames(file: string, renames: RenameSet): PermissionRuleRename[] {
  const legacyByLength = [...renames.matchers.keys()].sort((a, b) => b.length - a.length);
  const found = new Map<string, string>();
  for (const entries of Object.values(parseHooksFile(file))) {
    for (const entry of entries) {
      const matcher = entry.match;
      if (typeof matcher !== 'string') continue;
      const renamed = renameMatcherTokens(matcher, legacyByLength, renames.matchers);
      if (renamed !== matcher) {
        found.set(matcher, renamed);
        continue;
      }
      const lost = lostResourceMatches(matcher, renames.retiredTools);
      if (lost.length > 0) found.set(matcher, [matcher, ...lost].join('|'));
    }
  }
  return [...found].map(([old, next]) => ({ old, new: next }));
}


/**
 * A tool name list whose entries Damocles lists rather than rewrites: an agent definition's `disallowed_tools`,
 * or a scope's `damocles.tools.disabled`, in that scope's settings file or, on a host that keeps no such file
 * (VS Code's settings), as a setting the host's settings editor shows, at the user scope or else the workspace's.
 */
export type ToolNameList = { names: readonly string[] } & ({ path: string } | { setting: string; scope?: 'user' });

/**
 * Rewrites `damocles.tools.disabled` at each personal scope (user, and local in a trusted folder) entry by
 * entry, from the list that scope holds when the write runs, on the process-wide settings write chain.
 */
export type PersonalToolListRewriter = (rename: (name: string) => string) => Promise<void>;

/** The personal scopes' `damocles.tools.disabled`: its rewrite, and the lists as they are now for what stays. */
export interface PersonalToolLists {
  rewrite: PersonalToolListRewriter;
  lists: () => ToolNameList[];
}

/** The names in a list that are legacy names of renamed tools, each with its new name. */
function nameListRenames(names: readonly string[], renames: ReadonlyMap<string, string>): PermissionRuleRename[] {
  return names.flatMap((name) => {
    const current = renames.get(name);
    return current === undefined ? [] : [{ old: name, new: current }];
  });
}

/** A notice entry, marked when its replacement holds only in this folder because it names a folder server's resource. */
export interface RenamedRuleNoticeEntry extends PermissionRuleRename {
  perFolder: boolean;
}

/** A notice as the migration finds it, before it reaches the panels. */
export type FoundRuleNotice = McpRenamedToolRuleLocation & { rules: RenamedRuleNoticeEntry[] };

/** The notice as the panels show it. */
export function noticeForDisplay({ rules, ...location }: FoundRuleNotice): McpRenamedToolRuleNotice {
  return { ...location, rules: rules.map((rule) => ({ old: rule.old, new: rule.new })) };
}

/** Notice entries already shown, each by its location and content. */
export interface NoticeMemory {
  has(location: McpRenamedToolRuleLocation, entry: RenamedRuleNoticeEntry): boolean;
  add(location: McpRenamedToolRuleLocation, entries: readonly RenamedRuleNoticeEntry[]): Promise<void>;
}

/** Rules already added beside a rule, per owned file. */
export interface AdditionMemory {
  has(file: string, addition: string): boolean;
  add(file: string, additions: readonly string[]): Promise<void>;
}

export interface MigrationMemory {
  notices: NoticeMemory;
  /** Each rule added beside a rule of an owned file, so a later run never adds one the user deleted. */
  additions: AdditionMemory;
}

export interface RuleMigrationResult {
  notices: FoundRuleNotice[];
  /** False when the personal lists' rewrite failed, so the run is not done. */
  complete: boolean;
}

/** How an applied addition is remembered for its file. */
function additionKey(list: string, rule: string, added: string): string {
  return JSON.stringify([list, rule, added]);
}

/** `additions` without those `memory` holds for the file; `applied` collects the rest. */
function unappliedAdditions(file: string, additions: PermissionRuleAdditions, memory: AdditionMemory, applied?: Set<string>): PermissionRuleAdditions {
  return (rule, list) => additions(rule, list).filter((added) => {
    const key = additionKey(list, rule, added);
    if (memory.has(file, key)) return false;
    applied?.add(key);
    return true;
  });
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
 * Rewrite renamed and retired MCP tool names in the permission rules of the files Damocles owns and, through
 * `personal`, each retired resource tool's entry in the personal scopes' `damocles.tools.disabled` into the
 * URI-scoped entry that turns the same resource off; a place other folders share takes `renames.shared`. Then
 * collect, once per location, rule and replacement, what it must not rewrite: what is left in a shared place, rules in other
 * files, hook matchers and `toolNameLists` entries. Idempotent: a rewritten rule or entry no longer names a
 * legacy or retired tool, and an added rule and a shown notice entry are remembered.
 */
export async function migrateRenamedToolRules(
  folder: string | null,
  renames: ToolRenames,
  memory: MigrationMemory,
  toolNameLists: readonly ToolNameList[] = [],
  personal?: PersonalToolLists,
): Promise<RuleMigrationResult> {
  if (renames.rules.size === 0) return { notices: [], complete: true };
  const notices: FoundRuleNotice[] = [];
  const seen: FoundRuleNotice[] = [];
  type Finder = (set: RenameSet) => readonly PermissionRuleRename[] | Promise<readonly PermissionRuleRename[]>;
  // An entry the shared renames find unchanged reads the same in every folder.
  const collectAt = async (location: McpRenamedToolRuleLocation, find: Finder): Promise<void> => {
    const found = await find(renames);
    if (found.length === 0) return;
    const shared = await find(renames.shared);
    const entries = found.map((rule) => ({ ...rule, perFolder: !shared.some((other) => other.old === rule.old && other.new === rule.new) }));
    const known = entries.filter((entry) => memory.notices.has(location, entry));
    if (known.length > 0) seen.push({ ...location, rules: known });
    const fresh = entries.filter((entry) => !known.includes(entry));
    if (fresh.length === 0) return;
    const key = renamedRuleNoticeKey(location);
    const existing = notices.find((notice) => renamedRuleNoticeKey(notice) === key);
    if (existing) existing.rules.push(...fresh.filter((rule) => !existing.rules.some((shown) => shown.old === rule.old)));
    else notices.push({ ...location, rules: fresh });
  };
  const collect = (file: string, find: Finder): Promise<void> => collectAt({ path: file, displayPath: collapseHome(file) }, find);
  const collectList = (list: ToolNameList, entries: (set: RenameSet) => ReadonlyMap<string, string>): Promise<void> => {
    const find = (set: RenameSet) => nameListRenames(list.names, entries(set));
    if ('path' in list) return collect(list.path, find);
    const displayPath = list.scope === 'user' ? t('{0} in user settings', list.setting) : t('{0} in workspace settings', list.setting);
    return collectAt({ setting: list.setting, ...(list.scope ? { scope: list.scope } : {}), displayPath }, find);
  };

  for (const file of ownedRuleFiles(folder)) {
    const set = file.shared ? renames.shared : renames;
    const applied = new Set<string>();
    let rewritten: PermissionRuleRename[];
    try {
      rewritten = await rewritePermissionRuleToolNames(file.path, set.rules, {
        additions: unappliedAdditions(file.path, set.ruleAdditions, memory.additions, applied),
        ...(file.confineTo !== undefined ? { confineTo: file.confineTo } : {}),
      });
    } catch (err) {
      log('[ToolNameMigration] MCP permission rules in %s were not migrated (%s)', file.path, errorCode(err));
      continue;
    }
    if (rewritten.length > 0) log('[ToolNameMigration] renamed %d MCP permission rule(s) in %s', rewritten.length, file.path);
    if (applied.size > 0) await memory.additions.add(file.path, [...applied]);
    if (file.shared) await collect(file.path, (set) => findPermissionRuleRenames(file.path, set.rules, unappliedAdditions(file.path, set.ruleAdditions, memory.additions)));
  }
  let complete = true;
  if (personal && renames.retiredListEntries.size > 0) {
    const entries = renames.shared.retiredListEntries;
    if (entries.size > 0) {
      try {
        await personal.rewrite((name) => entries.get(name) ?? name);
      } catch (err) {
        log('[ToolNameMigration] damocles.tools.disabled was not migrated (%s)', errorCode(err));
        complete = false;
      }
    }
    for (const list of personal.lists()) await collectList(list, (set) => set.retiredListEntries);
  }

  for (const file of noticeRuleFiles(folder)) await collect(file, (set) => findPermissionRuleRenames(file, set.rules, set.ruleAdditions));
  if (renames.retiredTools.length > 0) {
    for (const file of claudeRuleFiles(folder)) await collect(file, (set) => findPermissionRuleRenames(file, set.retiredRules, set.ruleAdditions));
  }
  for (const file of hookFiles(folder)) await collect(file, (set) => findHookMatcherRenames(file, set));
  for (const list of toolNameLists) await collectList(list, (set) => set.names);
  // An entry remembered by its rule alone takes the content it stands for now.
  for (const notice of seen) await memory.notices.add(notice, notice.rules);
  return { notices, complete };
}
