/**
 * skill-loader.ts — Preload named skills into an agent's system prompt.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * The global root is the Damocles-owned pi agent dir (`PI_AGENT_DIR/skills`), not pi's `~/.pi`.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec)
 *   - PI_AGENT_DIR/skills        (user, Damocles-owned pi agent dir)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * The two project roots load only when `includeProjectScope` is true, since their contents go straight
 * into a subagent's system prompt.
 *
 * Layout per root: `<root>/<name>.md` (flat) or `<root>/.../<name>/SKILL.md` (directory skill), and nothing inside a
 * folder holding a SKILL.md is read. Recursion skips dotfile entries and node_modules, and follows links under
 * docs/invariants.md "Asset discovery and links".
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { boundedLog, compareInNameOrder, readAssetPath, SKILL_FILE, walkAssetTree, type AssetEntry } from '../../assets';
import { userConfigBase } from '../../config/local-config-path';
import { log } from '../../logger';
import { PI_AGENT_DIR } from '../agent-dir';
import { isUnsafeName } from './fs-safety';

const SKILL_MAX_DEPTH = 16;

export interface PreloadedSkill {
  name: string;
  content: string;
}

export interface PreloadSkillsOptions {
  /** Whether to read the project roots (`<cwd>/.pi/skills`, `<cwd>/.agents/skills`). Gate on VS Code workspace trust. */
  includeProjectScope: boolean;
}

interface SkillRoot {
  // the folder links below root are judged from (docs/invariants.md "Asset discovery and links")
  readonly scopeRoot: string;
  readonly root: string;
}

export async function preloadSkills(
  skillNames: string[],
  cwd: string,
  options: PreloadSkillsOptions,
): Promise<PreloadedSkill[]> {
  const projectRoots: SkillRoot[] = options.includeProjectScope
    ? [{ scopeRoot: cwd, root: join(cwd, '.pi', 'skills') }, { scopeRoot: cwd, root: join(cwd, '.agents', 'skills') }]
    : [];
  const userRoot = (root: string): SkillRoot => ({ scopeRoot: userConfigBase(root, homedir()), root });
  const roots: SkillRoot[] = [
    ...projectRoots,
    userRoot(join(PI_AGENT_DIR, 'skills')),
    userRoot(join(homedir(), '.agents', 'skills')),
    userRoot(join(homedir(), '.pi', 'skills')),
  ];
  const skillTrees = new Map<string, Promise<AssetEntry[]>>();
  const loaded: PreloadedSkill[] = [];
  for (const name of skillNames) {
    loaded.push({ name, content: await loadSkillContent(name, roots, skillTrees, options.includeProjectScope) });
  }
  return loaded;
}

async function loadSkillContent(
  name: string,
  roots: readonly SkillRoot[],
  skillTrees: Map<string, Promise<AssetEntry[]>>,
  includeProjectScope: boolean,
): Promise<string> {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  for (const root of roots) {
    const flat = await findFlatSkill(root, name);
    if (flat !== undefined) return flat;
    let tree = skillTrees.get(root.root);
    if (tree === undefined) {
      tree = walkSkills(root);
      skillTrees.set(root.root, tree);
    }
    const content = findSkillDirectory(await tree, name);
    if (content !== undefined) return content;
  }
  return includeProjectScope
    ? `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`
    : `(Skill "${name}" not found in global skill locations)`;
}

const skillLog = boundedLog((line) => log('%s', line));

// Every skill folder's SKILL.md under root; the walk reads nothing else inside a skill folder, as skills don't nest.
async function walkSkills(root: SkillRoot): Promise<AssetEntry[]> {
  const walk = await walkAssetTree({
    scopeRoot: root.scopeRoot,
    root: root.root,
    policy: { kind: 'follow' },
    maxDepth: SKILL_MAX_DEPTH,
    dirGlob: SKILL_FILE,
    leafFile: SKILL_FILE,
    repeatFolders: 'skip',
    skipHidden: true,
    log: skillLog,
  });
  return walk.entries;
}

// `<root>/<name>.md`, found by the file system's own name rules; isUnsafeName admits only [A-Za-z0-9._-] in name.
async function findFlatSkill(root: SkillRoot, name: string): Promise<string | undefined> {
  const flat = await readAssetPath({ scopeRoot: root.scopeRoot, root: root.root, segments: [`${name}.md`], policy: { kind: 'follow' }, log: skillLog });
  return flat?.kind === 'file' ? flat.text.trim() : undefined;
}

/** The SKILL.md of the shallowest skill folder named `name`, in name order within a level. */
function findSkillDirectory(entries: readonly AssetEntry[], name: string): string | undefined {
  const found = entries
    .filter((entry) => entry.kind === 'file' && entry.segments.length >= 2 && entry.segments.at(-1) === SKILL_FILE && entry.segments.at(-2) === name)
    .sort((a, b) => a.segments.length - b.segments.length || compareInNameOrder(a.segments, b.segments))[0];
  return found?.kind === 'file' ? found.text.trim() : undefined;
}
