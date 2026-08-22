import * as path from "path";
import * as vscode from "vscode";

/** Which compat asset source wins on a name collision between equivalently-shaped Claude and Codex assets. */
export type AssetSourcePrecedence = "claude" | "codex";

/** Every asset source Damocles discovers. `.damocles` outranks the compat sources unconditionally. */
export type AssetSourceName = "damocles" | AssetSourcePrecedence;

/**
 * An asset source's slash-command (prompt) and skill subfolders, relative to a scope root
 * (`<workspace>` or `~`). Codex stores custom-prompt slash commands under `prompts/` (not `commands/`);
 * its skills match Claude's folder-per-skill `SKILL.md` shape. Forward slashes so the specs feed both
 * `path.join` and `vscode.RelativePattern`/glob patterns unchanged.
 */
export interface AssetSource {
  /** Source label, used for resource source attribution. */
  name: AssetSourceName;
  /** Prompt-template (slash-command) folder relative to the scope root. */
  commands: string;
  /** Skills folder relative to the scope root. */
  skills: string;
}

const DAMOCLES_SOURCE: AssetSource = {
  name: "damocles",
  commands: ".damocles/commands",
  skills: ".damocles/skills",
};
const CLAUDE_SOURCE: AssetSource = { name: "claude", commands: ".claude/commands", skills: ".claude/skills" };
const CODEX_SOURCE: AssetSource = { name: "codex", commands: ".codex/prompts", skills: ".codex/skills" };

/** The configured Claude-vs-Codex precedence (`damocles.assetSourcePrecedence`, default `claude`). */
export function getAssetSourcePrecedence(): AssetSourcePrecedence {
  const value = vscode.workspace.getConfiguration("damocles").get<string>("assetSourcePrecedence", "claude");
  return value === "codex" ? "codex" : "claude";
}

/**
 * The asset sources ordered so the higher-precedence one comes first. `.damocles` is always first and
 * is deliberately outside `damocles.assetSourcePrecedence`, which stays a Claude-vs-Codex tie-break;
 * this matches how `.damocles/settings*.json` already outranks `.claude/settings*.json` in every
 * permission tier. Source precedence is the primary sort; within each source, callers scan project
 * before user.
 *
 * Both discovery systems (the pi resource loader and the `SlashCommandService` menu) iterate this same
 * root ordering with first-wins de-dup, so a name contested ACROSS roots resolves the same way in both.
 * What they find INSIDE a root differs, and the menu is deliberately the narrower of the two:
 *   - pi loads prompt templates from the top level of a commands dir only, while the menu also descends
 *     one level and lists `ns:name`, which pi has no template for.
 *   - pi walks a skills tree to any depth, follows a symlinked dir, and takes a root-level `*.md` as a
 *     skill; the menu lists only an immediate non-symlink subdir holding a `SKILL.md`.
 * A skill's name is the frontmatter `name:` when present in both systems, so pre-approval and
 * invocation cannot disagree.
 */
export function assetSources(
  precedence: AssetSourcePrecedence = getAssetSourcePrecedence(),
): AssetSource[] {
  return precedence === "codex"
    ? [DAMOCLES_SOURCE, CODEX_SOURCE, CLAUDE_SOURCE]
    : [DAMOCLES_SOURCE, CLAUDE_SOURCE, CODEX_SOURCE];
}

/** A candidate asset directory with the source it came from and the scope root it sits under. */
export interface AssetSourceDir {
  /** Absolute path. May not exist. */
  dir: string;
  source: AssetSourceName;
  scope: "project" | "user";
}

/**
 * Every candidate directory for `kind`, source-major and project before user within each source. The
 * project entry is skipped when `workspacePath` is null. Neither existence nor workspace trust is
 * filtered here: the resource loader drops untrusted project dirs while the menu keeps and badges them,
 * so a filter at this layer would force one of them to reconstruct what the other discarded.
 */
export function assetSourceDirs(
  kind: "skills" | "commands",
  opts: { workspacePath: string | null; homeDir: string },
): AssetSourceDir[] {
  const dirs: AssetSourceDir[] = [];
  for (const source of assetSources()) {
    const sub = kind === "skills" ? source.skills : source.commands;
    if (opts.workspacePath !== null) {
      dirs.push({ dir: path.join(opts.workspacePath, sub), source: source.name, scope: "project" });
    }
    dirs.push({ dir: path.join(opts.homeDir, sub), source: source.name, scope: "user" });
  }
  return dirs;
}
