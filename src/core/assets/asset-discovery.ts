import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';
import { ASSET_SEGMENT_RE, INVOCABLE_ASSET_NAME_RE } from '../../shared/asset-names';
import type { AssetWithheld, CustomSlashCommandInfo, RootWithheld, SkillInfo, WithheldRootInfo } from '../../shared/types/commands';
import { assetSourceDirs, type AssetSourceDir, type AssetSourceName } from '../asset-sources';
import { userConfigBase } from '../config/local-config-path';
import { folderKey } from '../workspace-folders/folder-key';
import { walkAssetTree, type AssetEntry, type AssetWalkOptions, type FollowPolicy, type LinkWithheld, type WatchTarget, type WithheldReason } from './asset-walk';

/** pi's `parseFrontmatter`, which throws on YAML it cannot parse. */
export type ParseFrontmatter = (content: string) => { frontmatter: Record<string, unknown>; body: string };

/** pi's `createSyntheticSourceInfo`. */
export type CreateSourceInfo = (filePath: string, options: { source: string; scope: 'user' | 'project'; origin: 'top-level'; baseDir: string }) => PromptTemplate['sourceInfo'];

export interface AssetScopes {
  // the project folder, or null for a target with no project scope
  readonly workspacePath: string | null;
  readonly homeDir: string;
  // whether the project is trusted; user roots always follow links
  readonly trusted: boolean;
  readonly log: (line: string) => void;
  // set when the caller holds a scan of the user roots already, so only the project roots are walked
  readonly skipUserRoots?: true;
}

export interface DiscoveryOptions extends AssetScopes {
  readonly parseFrontmatter: ParseFrontmatter;
}

// Link targets to watch, by the scope of the root that led to them.
export interface ScopedTargets {
  readonly project: WatchTarget[];
  readonly user: WatchTarget[];
}

interface Asset {
  readonly name: string;
  readonly scope: 'project' | 'user';
  readonly source: AssetSourceName;
  // through links
  readonly filePath: string;
  readonly untrusted: boolean;
  readonly withheld?: AssetWithheld;
}

export interface CommandAsset extends Asset {
  readonly namespace?: string;
  // absent when withheld
  readonly frontmatter?: Record<string, unknown>;
  readonly body?: string;
}

export interface SkillAsset extends Asset {
  // set when runnable
  readonly description?: string;
}

/** A commands or skills root a link withholds whole, so none of its entries is read. */
export interface WithheldRoot {
  readonly dir: AssetSourceDir;
  readonly untrusted: boolean;
  readonly reason: LinkWithheld;
}

export const SKILL_FILE = 'SKILL.md';
// pi's IGNORE_FILE_NAMES (pi dist/core/skills.js)
export const SKILL_IGNORE_FILES: readonly string[] = ['.gitignore', '.ignore', '.fdignore'];

const COMMAND_DEPTH = 1;
const MENU_SKILL_DEPTH = 1;
// pi's skill walk has no depth bound; this one stops where no real skill tree reaches
const PI_SKILL_DEPTH = 16;
// pi's own skill walk (pi dist/core/skills.js loadSkillsFromDirInternal)
const PI_SKILL_WALK = {
  rootGlob: '*.md',
  dirGlob: SKILL_FILE,
  leafFile: SKILL_FILE,
  repeatFolders: 'skip',
  skipHidden: true,
  ignoreFiles: SKILL_IGNORE_FILES,
} as const satisfies Partial<AssetWalkOptions>;
// pi's `/skill:` prefix claims this namespace; a folder is withheld only in this case, as pi's prefix check is case-sensitive
const RESERVED_NAMESPACE = 'skill';
const MAX_DETAIL_CHARS = 200;
const MAX_TARGET_CHARS = 1024;
const MAX_LOG_CHARS = 2048;

// Control characters, bidirectional formatting characters, and the line and paragraph separators.
const UNSAFE_TEXT = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]+/gu;

/** text with each run of control, bidirectional formatting and line separator characters made one space, trimmed, cut to max code points. */
export function boundedText(text: string, max: number): string {
  return [...text.replace(UNSAFE_TEXT, ' ').trim()].slice(0, max).join('');
}

// Log lines carry repository text (names, link targets, parser messages), so each is kept to one bounded line.
export function boundedLog(log: (line: string) => void): (line: string) => void {
  return (line: string) => log(boundedText(line, MAX_LOG_CHARS));
}

function withBoundedLog<T extends AssetScopes>(options: T): T {
  return { ...options, log: boundedLog(options.log) };
}

function toWithheld(reason: WithheldReason): AssetWithheld {
  return reason === 'tooLarge' ? { reason } : toRootWithheld(reason);
}

function toRootWithheld(reason: LinkWithheld): RootWithheld {
  return typeof reason === 'string' ? { reason } : { reason: 'broken', target: boundedText(reason.broken, MAX_TARGET_CHARS) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The policy a project root is walked under, from the project's realpath taken once per scan; undefined when it has none.
async function projectPolicy(options: AssetScopes): Promise<FollowPolicy | undefined> {
  if (options.workspacePath === null) return undefined;
  if (options.trusted) return { kind: 'follow' };
  try {
    return { kind: 'insideProject', project: await fs.realpath(options.workspacePath) };
  } catch (err) {
    options.log(`[assets] ${options.workspacePath}: ${errorMessage(err)}`);
    return undefined;
  }
}

interface WalkedRoot {
  readonly dir: AssetSourceDir;
  readonly entries: readonly AssetEntry[];
  readonly admitted: boolean;
  readonly withheld?: LinkWithheld;
}

type WalkShape = Omit<AssetWalkOptions, 'scopeRoot' | 'root' | 'policy' | 'log'>;

async function walkRoots(kind: 'commands' | 'skills', options: AssetScopes, shape: WalkShape, targets: ScopedTargets, dirs?: readonly AssetSourceDir[]): Promise<WalkedRoot[]> {
  const project = await projectPolicy(options);
  const walked: WalkedRoot[] = [];
  for (const dir of dirs ?? assetSourceDirs(kind, { workspacePath: options.workspacePath, homeDir: options.homeDir })) {
    if (dir.scope === 'user' && options.skipUserRoots) continue;
    const policy: FollowPolicy | undefined = dir.scope === 'user' ? { kind: 'follow' } : project;
    if (policy === undefined) continue;
    const scopeRoot = dir.scope === 'user' ? userConfigBase(dir.dir, options.homeDir) : options.workspacePath!;
    const walk = await walkAssetTree({ ...shape, scopeRoot, root: dir.dir, policy, log: options.log });
    targets[dir.scope].push(...walk.followed);
    walked.push({ dir, entries: walk.entries, admitted: walk.rootAdmitted, ...(walk.rootWithheld !== undefined ? { withheld: walk.rootWithheld } : {}) });
  }
  return walked;
}

function withheldRootsOf(walked: readonly WalkedRoot[], options: AssetScopes): WithheldRoot[] {
  return walked.flatMap(({ dir, withheld }) => (withheld === undefined ? [] : [{ dir, untrusted: dir.scope === 'project' && !options.trusted, reason: withheld }]));
}

/**
 * Every command file under the commands roots (`assetSourceDirs`), project before user within a source: `*.md` at the top
 * level and in first-level folders, real or linked, a folder naming its namespace. The menu and pi read only this.
 */
export async function discoverCommands(given: DiscoveryOptions): Promise<{ commands: CommandAsset[]; withheldRoots: WithheldRoot[]; followed: ScopedTargets }> {
  const options = withBoundedLog(given);
  const followed: ScopedTargets = { project: [], user: [] };
  const commands: CommandAsset[] = [];
  const walked = await walkRoots('commands', options, { maxDepth: COMMAND_DEPTH, dirGlob: '*.md', repeatFolders: 'walk', skipHidden: false }, followed);
  for (const { dir, entries } of walked) {
    const untrusted = dir.scope === 'project' && !options.trusted;
    for (const entry of entries) {
      const command = commandOf(entry, dir, untrusted, options);
      if (command !== undefined) commands.push(command);
    }
  }
  return { commands, withheldRoots: withheldRootsOf(walked, options), followed };
}

function commandOf(entry: AssetEntry, dir: AssetSourceDir, untrusted: boolean, options: DiscoveryOptions): CommandAsset | undefined {
  const base = { scope: dir.scope, source: dir.source, filePath: entry.path, untrusted };
  const [first, second] = entry.segments;
  // A withheld link at the top level that names no command file is a namespace folder, judged by its name alone.
  if (entry.kind === 'withheld' && entry.segments.length === 1 && !first!.endsWith('.md')) {
    if (!ASSET_SEGMENT_RE.test(first!)) return skipName(options, entry.path, first!);
    return { ...base, name: `${first}:`, namespace: first!, withheld: toWithheld(entry.reason) };
  }
  if (!(second ?? first)!.endsWith('.md')) return undefined;
  const namespace = second === undefined ? undefined : first!;
  const stem = (second ?? first)!.slice(0, -'.md'.length);
  const name = namespace === undefined ? stem : `${namespace}:${stem}`;
  if (!INVOCABLE_ASSET_NAME_RE.test(name)) return skipName(options, entry.path, name);
  const named = { ...base, name, ...(namespace !== undefined ? { namespace } : {}) };
  if (entry.kind === 'withheld') return { ...named, withheld: toWithheld(entry.reason) };
  if (namespace === RESERVED_NAMESPACE) {
    options.log(`[assets] ${entry.path}: reserved namespace ${RESERVED_NAMESPACE}`);
    return { ...named, withheld: { reason: 'reservedNamespace' } };
  }
  try {
    const { frontmatter, body } = options.parseFrontmatter(entry.text);
    return { ...named, frontmatter, body };
  } catch (err) {
    options.log(`[assets] ${entry.path}: invalid frontmatter: ${errorMessage(err)}`);
    return { ...named, withheld: { reason: 'invalidFrontmatter', detail: boundedText(errorMessage(err), MAX_DETAIL_CHARS) } };
  }
}

function skipName(options: DiscoveryOptions, file: string, name: string): undefined {
  options.log(`[assets] ${file}: not an invocable name: ${name}`);
  return undefined;
}

/**
 * The menu's skills: each immediate subfolder of a skills root, real or linked, holding a `SKILL.md`, which may itself be a
 * link, walked as pi walks the root. One `SKILL.md` reached twice is listed once, as pi loads it once. A root-level `*.md`,
 * which pi loads too, is not listed.
 */
export async function discoverSkills(given: DiscoveryOptions): Promise<{ skills: SkillAsset[]; withheldRoots: WithheldRoot[]; followed: ScopedTargets }> {
  const options = withBoundedLog(given);
  const followed: ScopedTargets = { project: [], user: [] };
  const skills: SkillAsset[] = [];
  // index in skills of the row each SKILL.md realpath gave; a runnable row replaces one that cannot run, as in mergeAssets
  const seen = new Map<string, number>();
  const walked = await walkRoots('skills', options, { ...PI_SKILL_WALK, maxDepth: MENU_SKILL_DEPTH }, followed);
  for (const { dir, entries } of walked) {
    const untrusted = dir.scope === 'project' && !options.trusted;
    for (const entry of entries) {
      const folder = entry.segments[0]!;
      // a withheld root-level entry is a skill folder unless its name says it is a file
      const listed = entry.segments.length === 2 ? entry.segments[1] === SKILL_FILE : entry.kind === 'withheld' && !folder.endsWith('.md');
      if (!listed || !ASSET_SEGMENT_RE.test(folder)) continue;
      const base = { scope: dir.scope, source: dir.source, filePath: entry.path, untrusted };
      if (entry.kind === 'withheld') {
        skills.push({ ...base, name: folder, withheld: toWithheld(entry.reason) });
        continue;
      }
      const key = folderKey(entry.realPath);
      const earlier = seen.get(key);
      if (earlier !== undefined && isRunnable(skills[earlier]!)) continue;
      const skill = skillOf(entry.text, folder, base, options, entry.path);
      if (skill === undefined) continue;
      if (earlier === undefined) {
        seen.set(key, skills.push(skill) - 1);
      } else if (isRunnable(skill)) {
        skills[earlier] = skill;
      }
    }
  }
  return { skills, withheldRoots: withheldRootsOf(walked, options), followed };
}

function skillOf(text: string, folder: string, base: Omit<SkillAsset, 'name'>, options: DiscoveryOptions, file: string): SkillAsset | undefined {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = options.parseFrontmatter(text).frontmatter;
  } catch (err) {
    options.log(`[assets] ${file}: invalid frontmatter: ${errorMessage(err)}`);
    return { ...base, name: folder, withheld: { reason: 'invalidFrontmatter', detail: boundedText(errorMessage(err), MAX_DETAIL_CHARS) } };
  }
  // pi loads the skill under its frontmatter name, so the menu pre-approves and invokes it under that same name.
  const declared = typeof frontmatter['name'] === 'string' ? frontmatter['name'].trim() : '';
  const name = declared === '' ? folder : declared;
  if (!ASSET_SEGMENT_RE.test(name)) {
    options.log(`[assets] ${file}: not an invocable skill name: ${name}`);
    return undefined;
  }
  const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'].trim() : '';
  if (description === '') {
    options.log(`[assets] ${file}: no description`);
    return { ...base, name, withheld: { reason: 'missingDescription' } };
  }
  return { ...base, name, description };
}

/**
 * The skill roots pi may load, as the policy admits them (user roots, and project roots when trusted), and the link targets
 * pi's own walk follows under them, found by walking as pi does with the same policy and loop guard.
 */
export async function skillLinkTargets(given: AssetScopes): Promise<{ roots: AssetSourceDir[]; followed: ScopedTargets }> {
  const options = withBoundedLog(given);
  const followed: ScopedTargets = { project: [], user: [] };
  const dirs = assetSourceDirs('skills', options).filter((dir) => options.trusted || dir.scope === 'user');
  const walked = await walkRoots('skills', options, { ...PI_SKILL_WALK, maxDepth: PI_SKILL_DEPTH }, followed, dirs);
  return { roots: walked.filter((root) => root.admitted).map((root) => root.dir), followed };
}

/** First wins by lowercased name, except that a row which cannot run yields to a later one that can. */
export function mergeAssets<T extends { readonly name: string; readonly untrusted?: boolean; readonly withheld?: unknown }>(rows: Iterable<T>): T[] {
  const byName = new Map<string, T>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const claimed = byName.get(key);
    if (claimed === undefined || (!isRunnable(claimed) && isRunnable(row))) byName.set(key, row);
  }
  return [...byName.values()];
}

export function isRunnable(row: { readonly untrusted?: boolean; readonly withheld?: unknown }): boolean {
  return row.untrusted !== true && row.withheld === undefined;
}

/**
 * The row named name, or for `ns:x` with no such row, the withheld row of the namespace folder `ns`. A name in the reserved
 * namespace finds no row, in any case, so the send path hands `/skill:<name>` to pi, whose own skill invocation claims it.
 */
export function findAsset<T extends { readonly name: string; readonly namespace?: string }>(rows: readonly T[], name: string): T | undefined {
  const wanted = name.toLowerCase();
  if (wanted.startsWith(`${RESERVED_NAMESPACE}:`)) return undefined;
  const exact = rows.find((row) => row.name.toLowerCase() === wanted);
  if (exact !== undefined || !wanted.includes(':')) return exact;
  const folder = `${wanted.slice(0, wanted.indexOf(':'))}:`;
  return rows.find((row) => row.name.toLowerCase() === folder);
}

function frontmatterString(frontmatter: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = frontmatter?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function toMenuCommand(command: CommandAsset): CustomSlashCommandInfo {
  const argumentHint = command.withheld === undefined ? frontmatterString(command.frontmatter, 'argument-hint') : undefined;
  return {
    name: command.name,
    description: command.withheld === undefined ? frontmatterString(command.frontmatter, 'description') ?? extractFirstLine(command.body ?? '') : '',
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    filePath: command.filePath,
    source: command.scope,
    ...(command.untrusted ? { untrusted: true } : {}),
    ...(command.namespace !== undefined ? { namespace: command.namespace } : {}),
    ...(command.withheld !== undefined ? { withheld: command.withheld } : {}),
  };
}

export function toMenuSkill(skill: SkillAsset): SkillInfo {
  return {
    name: skill.name,
    description: skill.description ?? '',
    filePath: skill.filePath,
    source: skill.scope,
    ...(skill.untrusted ? { untrusted: true } : {}),
    ...(skill.withheld !== undefined ? { withheld: skill.withheld } : {}),
  };
}

export function toMenuRoot(root: WithheldRoot, assets: WithheldRootInfo['assets']): WithheldRootInfo {
  return {
    kind: 'withheldRoot',
    assets,
    // each source's folder is its name with a leading dot (asset-sources.ts)
    folder: `.${root.dir.source}`,
    source: root.dir.scope,
    filePath: root.dir.dir,
    ...(root.untrusted ? { untrusted: true } : {}),
    withheld: toRootWithheld(root.reason),
  };
}

/** A runnable command as pi's `loadTemplateFromFile` builds a template (pi dist/core/prompt-templates.js), named `ns:name` in a namespace. */
export function toPromptTemplate(command: CommandAsset, createSourceInfo: CreateSourceInfo): PromptTemplate {
  const frontmatter = command.frontmatter ?? {};
  const body = command.body ?? '';
  let description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
  if (!description) {
    const firstLine = body.split('\n').find((line) => line.trim());
    if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
  }
  const argumentHint = typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined;
  return {
    name: command.name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    content: body,
    sourceInfo: createSourceInfo(command.filePath, { source: command.source, scope: command.scope, origin: 'top-level', baseDir: path.dirname(command.filePath) }),
    filePath: command.filePath,
  };
}

function extractFirstLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return stripMarkdownFormatting(trimmed).slice(0, 100);
  }
  return 'No description';
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(^|\s)__(.+?)__(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
