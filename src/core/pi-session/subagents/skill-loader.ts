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
 * Layout per root: `<root>/<name>.md` (flat) or `<root>/.../<name>/SKILL.md` (directory skill).
 * Recursion skips dotfile entries and node_modules; symlinks are rejected for security.
 */

import type { Dirent } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PI_AGENT_DIR } from '../agent-dir';
import { isSymlink, isUnsafeName, safeReadFile } from './fs-safety';

export interface PreloadedSkill {
  name: string;
  content: string;
}

export interface PreloadSkillsOptions {
  /** Whether to read the project roots (`<cwd>/.pi/skills`, `<cwd>/.agents/skills`). Gate on VS Code workspace trust. */
  includeProjectScope: boolean;
}

export function preloadSkills(
  skillNames: string[],
  cwd: string,
  options: PreloadSkillsOptions,
): PreloadedSkill[] {
  return skillNames.map((name) => ({
    name,
    content: loadSkillContent(name, cwd, options.includeProjectScope),
  }));
}

function loadSkillContent(name: string, cwd: string, includeProjectScope: boolean): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  const projectRoots = includeProjectScope
    ? [join(cwd, '.pi', 'skills'), join(cwd, '.agents', 'skills')]
    : [];
  const roots = [
    ...projectRoots,
    join(PI_AGENT_DIR, 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.pi', 'skills'),
  ];
  for (const root of roots) {
    const content = findInRoot(root, name);
    if (content !== undefined) return content;
  }
  return includeProjectScope
    ? `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`
    : `(Skill "${name}" not found in global skill locations)`;
}

function findInRoot(root: string, name: string): string | undefined {
  if (isSymlink(root)) return undefined;
  const flat = safeReadFile(join(root, `${name}.md`))?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name);
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. */
function findSkillDirectory(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow a dir symlink out of the skills tree
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const path = join(current, entry.name);
      const skillMd = join(path, 'SKILL.md');
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const content = safeReadFile(skillMd)?.trim();
          if (content !== undefined) return content;
        }
        continue; // skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}
