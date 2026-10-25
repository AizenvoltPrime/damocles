import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'path';
import ignore from 'ignore';
import type { FileWatcher } from '../../../platform/file-watcher';
import type { Platform } from '../../../platform/platform';
import type { PermissionState } from '../state';
import type { McpToolIdentity } from '../types';
import type { PermissionBehavior } from '../../../shared/types/permissions';
import { fileRulePattern, loadPermissionsByPriority, usableGitignorePattern, type FilePermissions } from '../permission-settings';
import { READ_ONLY_TOOLS, ORCHESTRATION_TOOLS, TOOL_EDIT, TOOL_WRITE, TOOL_READ, TOOL_GENERATE_IMAGE, TOOL_GREP, TOOL_GLOB, TOOL_LS, SHELL_TOOLS } from '../../../shared/tool-names';
import { isPlanFilePath } from '../../paths';
import { canonicalPath, spelledPath } from '../../canonical-path';
import { resolveToCwd } from '../../pi-session/tools/search-tools';
import { MCP_TOOL_PREFIX } from '../../pi-session/mcp/naming';
import { matchesToolPattern } from '../../pi-session/mcp/exposure';
import { READ_MCP_RESOURCE, uriRuleCovers, type McpResourceRuleFilter } from '../mcp-resource-rule';
import { bypassAllowed, currentPin } from '../../client-snapshots';
import type { PermissionRuleLists } from '../../../shared/remote-user';

/** Every built-in tool that edits a file; an `Edit` rule covers each of them. */
const EDIT_RULE_TOOLS: ReadonlySet<string> = new Set([TOOL_EDIT, TOOL_WRITE, TOOL_GENERATE_IMAGE]);

/** Tools that read the files below a path; a `Read` deny or ask rule covers what they search. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([TOOL_GREP, TOOL_GLOB, TOOL_LS]);

/** `Tool` or `Tool(specifier)`, where the tool name may hold `*` wildcards. */
const RULE_SHAPE = /^([\w*-]+)(?:\((.+)\))?$/;

/** A pin with no client user rules; one shared value, since the permissions cache compares rule lists by identity. */
const NO_CLIENT_RULES: readonly PermissionRuleLists[] = Object.freeze([]);

/** pi's `resolveReadPath` (`dist/core/tools/path-utils.js`), which its package does not export; keep the two in step. */
function resolveReadPath(resolved: string): string {
  const nfd = resolved.normalize('NFD');
  const candidates = [resolved, resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, resolved.replace(/'/g, '\u2019'), nfd.replace(/'/g, '\u2019')];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolved;
}

/** Whether a rule's tool name, in which `*` matches any run of characters, names the whole of `name`; linear, since `name` can be a model-written server. */
function namesTool(ruleName: string, name: string): boolean {
  return matchesToolPattern(ruleName, name);
}

/** Whether a rule's server or tool part names `raw` as written or as Claude Code spells it (`[^A-Za-z0-9_-]` as `_`). */
function namesMcp(ruleName: string, raw: string): boolean {
  return namesTool(ruleName, raw) || namesTool(ruleName, raw.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/**
 * Claude Code's `mcp__server`, `mcp__server__*` and `mcp__server__tool`, matched against the server's
 * config name and the server's own tool name, since the pi name is sanitized, truncated and hashed and
 * so can be shared by another server's tools. A rule equal to the pi name, as the renamed-tool migration
 * writes rules, names that one tool.
 */
export function matchesMcpRule(rule: string, toolName: string, mcpTool: McpToolIdentity | undefined): boolean {
  if (rule === toolName) return true;
  if (!mcpTool) return false;
  const body = rule.slice(MCP_TOOL_PREFIX.length);
  const server = body.endsWith('__*') ? body.slice(0, -3) : body.includes('__') ? null : body;
  if (server !== null) return namesMcp(server, mcpTool.server);
  return mcpRuleSplits(rule, mcpTool).length > 0;
}

/** Each `mcp__<server>__<tool>` reading of a rule under which it names `mcpTool`; either name may contain `__`. */
export function mcpRuleSplits(rule: string, mcpTool: McpToolIdentity): { server: string; tool: string }[] {
  const body = rule.slice(MCP_TOOL_PREFIX.length);
  const splits: { server: string; tool: string }[] = [];
  for (let at = body.indexOf('__'); at !== -1; at = body.indexOf('__', at + 1)) {
    const split = { server: body.slice(0, at), tool: body.slice(at + 2) };
    if (namesMcp(split.server, mcpTool.server) && namesMcp(split.tool, mcpTool.tool)) splits.push(split);
  }
  return splits;
}

/** Damocles' `mcp__<server>__read_mcp_resource(<uri pattern>)`, for a `read_mcp_resource` call naming the server and a URI. */
function matchesMcpResourceUriRule(rule: string, toolName: string, input: Record<string, unknown>, mcpTool: McpToolIdentity | undefined): boolean {
  if (toolName !== READ_MCP_RESOURCE || mcpTool?.tool !== READ_MCP_RESOURCE) return false;
  const uri = input['uri'];
  return typeof uri === 'string' && uriRuleCovers(rule, mcpTool.server, uri);
}

/** `resolve` memoized for one evaluation, which resolves the cwd and each rule's folder once per call. */
function memoized(resolve: (target: string) => string): (target: string) => string {
  const cache = new Map<string, string>();
  return (target) => {
    let value = cache.get(target);
    if (value === undefined) {
      value = resolve(target);
      cache.set(target, value);
    }
    return value;
  };
}

interface PathResolvers {
  canonical: (target: string) => string;
  spelled: (target: string) => string;
}

const pathResolvers = (): PathResolvers => ({ canonical: memoized(canonicalPath), spelled: memoized(spelledPath) });

export class EvaluatorManager {
  private state: PermissionState;
  private cachedPermissions: FilePermissions[] | null = null;
  private cachedFor: string | null = null;
  private cachedClientRules: readonly PermissionRuleLists[] | undefined;
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;
  private ruleSaves: Promise<void> = Promise.resolve();
  private settingsWatchers: FileWatcher[] = [];
  private readonly platform: Pick<Platform, 'trust' | 'fileWatchers' | 'remote'>;

  /** Windows path rules for file rules: case-insensitive names and NTFS stream syntax. */
  private readonly windowsPaths: boolean;

  constructor(
    state: PermissionState,
    platform: Pick<Platform, 'trust' | 'fileWatchers' | 'remote'>,
    windowsPaths: boolean = process.platform === 'win32',
  ) {
    this.state = state;
    this.platform = platform;
    this.windowsPaths = windowsPaths;
    this.setupSettingsWatcher();
  }

  /**
   * "Always allow" is saving a rule while its call already runs: the next decision waits for the write and reads the files
   * again, as a watcher may report the write late or, for a home file, never.
   */
  savingRules(save: Promise<unknown>): void {
    const saved = save.then(() => undefined, () => undefined);
    this.ruleSaves = Promise.all([this.ruleSaves, saved]).then(() => {
      this.cachedPermissions = null;
    });
  }

  private setupSettingsWatcher(): void {
    const invalidate = () => { this.cachedPermissions = null; };
    // A watcher takes a single glob, so each settings directory needs its own watcher.
    for (const pattern of ['**/.claude/settings*.json', '**/.damocles/settings*.json']) {
      const watcher = this.platform.fileWatchers.watchWorkspace(pattern);
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);
      this.settingsWatchers.push(watcher);
    }
  }

  async evaluate(
    toolName: string,
    input: Record<string, unknown>,
    workspacePath: string | null,
    mcpTool?: McpToolIdentity,
  ): Promise<PermissionBehavior> {
    return this.decide(toolName, input, await this.matchRule(toolName, input, workspacePath, mcpTool));
  }

  /**
   * The verdict on a call under the current mode and YOLO, given `rule`, the settings rule it matches
   * (`matchRule`). Synchronous, so an open prompt can be decided again the moment the mode changes.
   */
  decide(toolName: string, input: Record<string, unknown>, rule: PermissionBehavior | null): PermissionBehavior {
    if (this.bypassing()) {
      return 'allow';
    }

    // A matching rule decides before any mode or tool default, so an ask rule prompts even for a read.
    if (rule) {
      return rule;
    }

    if ((toolName === TOOL_EDIT || toolName === TOOL_WRITE) && this.isPlanFile(typeof input['file_path'] === 'string' ? input['file_path'] : '')) {
      return 'allow';
    }

    // MCP tools auto-allow unless a rule says otherwise: the user's server list is their trust boundary.
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      return 'allow';
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return 'allow';
    }

    if (ORCHESTRATION_TOOLS.has(toolName)) {
      return 'allow';
    }

    if (this.state.permissionMode === 'acceptEdits') {
      if ((toolName === TOOL_EDIT || toolName === TOOL_WRITE || toolName === TOOL_GENERATE_IMAGE) && !this.linksOutOfCwd(typeof input['file_path'] === 'string' ? input['file_path'] : '')) {
        return 'allow';
      }
    }

    return 'ask';
  }

  /**
   * The behavior of the settings rule the call matches, or null when none does or YOLO is on. A deny in
   * any settings file wins, then an ask in any file, then an allow, so a repository's allow never
   * overrides the user's own deny or ask.
   */
  async matchRule(toolName: string, input: Record<string, unknown>, workspacePath: string | null, mcpTool?: McpToolIdentity): Promise<PermissionBehavior | null> {
    if (this.bypassing()) {
      return null;
    }
    const permissions = await this.getPermissions(this.trustedWorkspace(workspacePath));
    return this.matchAgainstPatterns(toolName, input, permissions, mcpTool);
  }

  /**
   * Whether a `Read` deny or ask rule covers a file a search lists or reads, for Grep and Glob to leave
   * it out of a search rooted above it. Nothing is covered under YOLO.
   */
  async readRuleFilter(workspacePath: string | null): Promise<(filePath: string) => boolean> {
    if (this.bypassing()) return () => false;
    const permissions = await this.getPermissions(this.trustedWorkspace(workspacePath));
    const resolvers = pathResolvers();
    return (filePath) => permissions.some((file) =>
      (['deny', 'ask'] as const).some((behavior) =>
        file[behavior].some((rule, index, rules) => this.matchesPattern(TOOL_READ, { file_path: filePath }, rule, behavior, file.root, undefined, resolvers, rules.slice(index + 1)))));
  }

  /**
   * What an MCP resource list call of `toolName` leaves out: servers a deny or ask rule covers for that
   * tool, and resources a deny rule covers for `read_mcp_resource`; and the contents a read leaves out.
   * Nothing is covered under YOLO.
   */
  async mcpResourceRuleFilter(toolName: string, workspacePath: string | null): Promise<McpResourceRuleFilter> {
    if (this.bypassing()) {
      return { serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false };
    }
    const permissions = await this.getPermissions(this.trustedWorkspace(workspacePath));
    const resolvers = pathResolvers();
    const coveringRule = (behaviors: readonly PermissionBehavior[], tool: string, input: Record<string, unknown>, server: string): string | undefined => {
      for (const file of permissions) {
        for (const behavior of behaviors) {
          const rule = file[behavior].find((pattern, index, rules) => this.matchesPattern(tool, input, pattern, behavior, file.root, { server, tool }, resolvers, rules.slice(index + 1)));
          if (rule !== undefined) return rule;
        }
      }
      return undefined;
    };
    const resourceDenyRule = (server: string, uri: string): string | undefined => coveringRule(['deny'], READ_MCP_RESOURCE, { server, uri }, server);
    const coveredByAnotherAsk = (server: string, uri: string, readUri: string): boolean => permissions.some((file) =>
      file.ask.some((pattern, index, rules) => {
        const covers = (target: string) =>
          this.matchesPattern(READ_MCP_RESOURCE, { server, uri: target }, pattern, 'ask', file.root, { server, tool: READ_MCP_RESOURCE }, resolvers, rules.slice(index + 1));
        return covers(uri) && !covers(readUri);
      }));
    return {
      serverCovered: (server) => coveringRule(['deny', 'ask'], toolName, { server }, server) !== undefined,
      resourceDenied: (server, uri) => resourceDenyRule(server, uri) !== undefined,
      resourceDenyRule,
      contentCovered: (server, uri, readUri) => resourceDenyRule(server, uri) !== undefined || coveredByAnotherAsk(server, uri, readUri),
    };
  }

  // YOLO as set, re-checked against the pinned client's policy at each decision
  private bypassing(): boolean {
    return this.state.dangerouslySkipPermissions && bypassAllowed(this.platform);
  }

  /**
   * A repository's own settings files could allow anything, so they count only once the window is
   * trusted. Read per call: granting trust changes the cache key, so the next call reloads.
   */
  private trustedWorkspace(workspacePath: string | null): string | null {
    return workspacePath !== null && this.platform.trust.isTrusted(workspacePath) ? workspacePath : null;
  }

  /** Whether `filePath`, resolved against the session cwd as the tools resolve it, is a plan file. */
  isPlanFile(filePath: string): boolean {
    return filePath !== '' && isPlanFilePath(resolveToCwd(filePath, this.sessionCwd()));
  }

  /** Whether `filePath` is inside the cwd as written but resolves outside it through a link or junction. */
  private linksOutOfCwd(filePath: string): boolean {
    const cwd = this.sessionCwd();
    const requested = resolveToCwd(filePath, cwd);
    const inside = (folder: string, target: string): boolean => {
      const relative = path.relative(folder, target);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    return inside(spelledPath(cwd), spelledPath(requested)) && !inside(canonicalPath(path.resolve(cwd)), canonicalPath(requested));
  }

  private sessionCwd(): string {
    const cwd = this.state.cwd;
    if (cwd === null) throw new Error('File permission rules need the session cwd, and none is set');
    return cwd;
  }

  /**
   * Cached per workspace, not just per age: the eight paths this resolves are half workspace-relative,
   * and a panel's handler moves to another workspace when the panel switches folder, so a hit for the
   * previous workspace would answer with another project's rules.
   */
  private async getPermissions(workspacePath: string | null): Promise<FilePermissions[]> {
    // the turn's pinned client's user rules on a daemon's core
    const clientRules = this.platform.remote ? (currentPin(this.platform.remote).user?.permissionRules ?? NO_CLIENT_RULES) : undefined;
    await this.ruleSaves;
    const now = Date.now();
    if (
      this.cachedPermissions &&
      this.cachedFor === workspacePath &&
      this.cachedClientRules === clientRules &&
      (now - this.cacheTime) < this.CACHE_TTL_MS
    ) {
      return this.cachedPermissions;
    }
    this.cachedPermissions = await loadPermissionsByPriority(workspacePath, clientRules);
    this.cachedFor = workspacePath;
    this.cachedClientRules = clientRules;
    this.cacheTime = now;
    return this.cachedPermissions;
  }

  private matchAgainstPatterns(
    toolName: string,
    input: Record<string, unknown>,
    permissionsByFile: FilePermissions[],
    mcpTool: McpToolIdentity | undefined,
  ): PermissionBehavior | null {
    const resolvers = pathResolvers();
    for (const behavior of ['deny', 'ask', 'allow'] as PermissionBehavior[]) {
      for (const filePerms of permissionsByFile) {
        const rules = filePerms[behavior];
        for (const [index, pattern] of rules.entries()) {
          if (this.matchesPattern(toolName, input, pattern, behavior, filePerms.root, mcpTool, resolvers, rules.slice(index + 1))) {
            return behavior;
          }
        }
      }
    }
    return null;
  }

  private matchesPattern(
    toolName: string,
    input: Record<string, unknown>,
    pattern: string,
    behavior: PermissionBehavior,
    root: string,
    mcpTool: McpToolIdentity | undefined,
    resolvers: PathResolvers,
    later: readonly string[],
  ): boolean {
    // Claude Code skips an `mcp__` rule with parentheses; the URI-scoped resource form is Damocles' one exception.
    if (pattern.startsWith(MCP_TOOL_PREFIX)) {
      return /[()]/.test(pattern) ? matchesMcpResourceUriRule(pattern, toolName, input, mcpTool) : matchesMcpRule(pattern, toolName, mcpTool);
    }
    const match = pattern.match(RULE_SHAPE);
    if (!match) return false;

    const [, ruleTool = '', specifier] = match;
    const editRule = ruleTool === TOOL_EDIT && EDIT_RULE_TOOLS.has(toolName);
    const searchRule = ruleTool === TOOL_READ && behavior !== 'allow' && SEARCH_TOOLS.has(toolName);
    // A `Read` deny rule also keeps its paths from being edited or created.
    const readDenyRule = ruleTool === TOOL_READ && behavior === 'deny' && specifier !== undefined && EDIT_RULE_TOOLS.has(toolName);
    if (!namesTool(ruleTool, toolName) && !editRule && !searchRule && !readDenyRule) return false;
    if (!specifier) return true;

    if (SHELL_TOOLS.has(toolName)) {
      return this.matchShellSpecifier(input, specifier);
    }
    const carveOuts = later.flatMap((rule) => {
      const [, tool, carveOut] = rule.match(RULE_SHAPE) ?? [];
      return tool === ruleTool && carveOut?.startsWith('!') ? [carveOut.slice(1)] : [];
    });
    if (searchRule) {
      return this.searchedPaths(toolName, input).some(({ target, contents }) =>
        this.matchFileSpecifier(TOOL_READ, target, specifier, behavior, root, resolvers, carveOuts, contents));
    }
    if (toolName === TOOL_READ || EDIT_RULE_TOOLS.has(toolName)) {
      const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
      return this.matchFileSpecifier(toolName, filePath, specifier, behavior, root, resolvers, carveOuts);
    }
    return false;
  }

  /**
   * What a Grep, Glob or Ls call reads, as `Read` rules see it: its root as a file, the folder's contents,
   * and the root joined with a Grep `glob` or Glob `pattern`, so a search naming a covered file matches.
   */
  private searchedPaths(toolName: string, input: Record<string, unknown>): Array<{ target: string; contents: boolean }> {
    const base = typeof input['path'] === 'string' && input['path'] ? input['path'] : '.';
    const searched = [{ target: base, contents: false }, { target: base, contents: true }];
    const named = toolName === TOOL_GREP ? input['glob'] : toolName === TOOL_GLOB ? input['pattern'] : undefined;
    if (typeof named === 'string' && named) searched.push({ target: path.resolve(resolveToCwd(base, this.sessionCwd()), named), contents: false });
    return searched;
  }

  private matchShellSpecifier(input: Record<string, unknown>, specifier: string): boolean {
    const command = typeof input['command'] === 'string' ? input['command'] : '';

    if (specifier.endsWith(':*')) {
      const prefix = specifier.slice(0, -2);
      return command.startsWith(prefix);
    }

    if (specifier.endsWith(' *')) {
      const prefix = specifier.slice(0, -2);
      return command.startsWith(prefix + ' ') || command === prefix;
    }

    return command === specifier;
  }

  /**
   * Matches two paths: the one the tool opens, resolved as the tool resolves it and spelled as the file
   * system stores it, and the file it resolves to through links, junctions, 8.3 names and loopback
   * shares. Each is matched with gitignore semantics (node-ignore) relative to the rule's anchor, so a
   * rule never matches above its anchor. An allow rule needs both inside their cwd and matching there.
   * A deny or ask rule matches any form of either. `carveOuts` are the `!` patterns listed after this
   * rule for the same tool in the same list. `contents` matches the inside of the folder at `filePath`,
   * so `secrets/**` covers a search of `secrets`. `root` is the folder a `/path` rule is relative to.
   * See "File rules" in docs/invariants.md.
   */
  private matchFileSpecifier(
    toolName: string,
    filePath: string,
    specifier: string,
    behavior: PermissionBehavior,
    root: string,
    resolvers: PathResolvers,
    carveOuts: string[],
    contents = false,
  ): boolean {
    // A `!` rule only carves paths out of the rules listed before it.
    if (!filePath || specifier.startsWith('!')) return false;
    const cwd = this.sessionCwd();

    const windows = this.windowsPaths;
    const fold = (value: string): string => (windows ? value.toLowerCase() : value);
    // Claude Code matches a Windows path in POSIX form, `C:\Users` as `/c/Users`.
    const posix = (value: string): string => {
      const slashed = value.split(path.sep).join('/');
      return /^[A-Za-z]:\//.test(slashed) ? `/${slashed[0]!.toLowerCase()}${slashed.slice(2)}` : slashed;
    };
    const native = (value: string): string =>
      path.sep === '\\' && /^\/[A-Za-z](\/|$)/.test(value) ? `${value[1]!.toUpperCase()}:${value.slice(2) || '/'}`.split('/').join('\\') : value;

    const { anchor, pattern } = fileRulePattern(specifier, windows);
    // An allow rule with an unusable path never gets here: `ruleList` drops it.
    const usable = usableGitignorePattern(pattern);
    // A relative `src/**` or `src/*.ts` matches at any depth under the cwd as a deny or ask rule.
    const shaped = (relative: string): string =>
      behavior !== 'allow' && /^(?!\*\*\/)[^/]+\/[^/]+$/.test(relative.replace(/\/$/, '')) ? `**/${relative}` : relative;

    // `target` relative to `folder` in POSIX form, or null when it is not under it. Under the file system
    // root (null) a UNC path is `//server/share`; a `\\?\` or `\\.\` device path is not, as node-ignore rejects `./`.
    const under = (folder: string | null, target: string): string | null => {
      if (folder === null) {
        const slashed = posix(target).match(/^(?:\/\/(?=[^/?.])|\/(?!\/))(.*?)\/?$/);
        return slashed ? slashed[1]! : null;
      }
      const relative = path.relative(folder, target);
      return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ? null : posix(relative);
    };

    // A rule's literal leading folders, resolved through links and 8.3 names, also anchor the rest of
    // the pattern, so a rule written through a link covers the real location. On Windows a `//` rule's
    // folders resolve only from a drive (`//c/...`): `/tmp` is no Windows path.
    const base = anchor === 'root' ? null : anchor === 'home' ? homedir() : anchor === 'settings' ? root : cwd;
    const segments = (anchor === 'cwd' ? pattern : pattern.slice(1)).split('/');
    const last = segments.length - (segments[segments.length - 1] === '' ? 2 : 1);
    let literal = 0;
    while (literal < last && segments[literal] !== '' && !/[*?[\\]/.test(segments[literal]!)) literal++;
    if (base === null && path.sep === '\\' && !/^[A-Za-z]$/.test(segments[0]!)) literal = 0;
    const folder = segments.slice(0, literal).join('/');
    const rest = `/${segments.slice(literal).join('/')}`;
    const linked = folder === '' ? base : base === null ? native(`/${folder}`) : path.join(base, folder);

    // Each view is a folder and the pattern relative to it; the second and third are spelled and canonical.
    type View = { folder: string | null; pattern: string };
    let views: View[];
    if (anchor === 'cwd') {
      const relative = usable ? shaped(pattern) : pattern;
      const cwds = [cwd, resolvers.spelled(cwd), resolvers.canonical(path.resolve(cwd))];
      views = cwds.map((folder) => ({ folder, pattern: relative }));
      // Only a folder that resolves elsewhere inside the cwd adds a view: a relative rule never reaches outside the cwd.
      if (behavior !== 'allow' && folder !== '') {
        views.push(...[resolvers.spelled(linked!), resolvers.canonical(linked!)]
          .filter((resolved, index) => { const inside = under(cwds[index + 1]!, resolved); return inside !== null && fold(inside) !== fold(folder); })
          .map((resolved) => ({ folder: resolved, pattern: rest })));
      }
    } else {
      views = [{ folder: base, pattern }, { folder: linked && resolvers.spelled(linked), pattern: rest }, { folder: linked && resolvers.canonical(linked), pattern: rest }];
    }
    const negations = anchor === 'cwd' ? carveOuts.map((carveOut) => `!${shaped(carveOut.replace(/^\.\//, ''))}`) : [];
    const covers = ({ folder, pattern: glob }: View, target: string): boolean => {
      const relative = under(folder, target);
      if (relative === null) return false;
      // A `:` is an NTFS stream, which can name another file or folder: it bars an allow, and deny and ask match without it.
      if (windows && behavior === 'allow' && relative.includes(':')) return false;
      // A segment keeps its first character, so the path stays one node-ignore accepts (`::1` is an IPv6 UNC host).
      const plain = windows ? relative.replace(/(?<=[^/]):[^/]*/g, '') : relative;
      // An unusable pattern is read as the path it spells, where on Windows `\` separates folders.
      if (!usable) return fold(plain) === fold(windows ? glob.replace(/\\/g, '/').replace(/^\/|\/+$/g, '') : glob.replace(/^\//, ''));
      if (plain === '') return false;
      const rules = ignore({ ignorecase: windows }).add([glob, ...negations]);
      return contents ? rules.checkIgnore(`${plain}/`).ignored : rules.ignores(plain);
    };

    const requested = resolveToCwd(filePath, cwd);
    const spelled = resolvers.spelled(requested);
    const canonical = resolvers.canonical(toolName === TOOL_READ ? resolveReadPath(requested) : requested);
    if (behavior === 'allow') {
      if (under(resolvers.spelled(cwd), spelled) === null || under(resolvers.canonical(path.resolve(cwd)), canonical) === null) return false;
      return covers(views[1]!, spelled) && covers(views[2]!, canonical);
    }
    return views.some((view) => [requested, spelled, canonical].some((target) => covers(view, target)));
  }

  dispose(): void {
    for (const watcher of this.settingsWatchers) {
      watcher.dispose();
    }
    this.settingsWatchers = [];
  }
}
