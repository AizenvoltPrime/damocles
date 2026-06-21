import * as vscode from "vscode";

/** Which compat asset source wins on a name collision between equivalently-shaped Claude and Codex assets. */
export type AssetSourcePrecedence = "claude" | "codex";

/**
 * A compat asset source's slash-command (prompt) and skill subfolders, relative to a scope root
 * (`<workspace>` or `~`). Codex stores custom-prompt slash commands under `prompts/` (not `commands/`);
 * its skills match Claude's folder-per-skill `SKILL.md` shape. Forward slashes so the specs feed both
 * `path.join` and `vscode.RelativePattern`/glob patterns unchanged.
 */
export interface CompatSource {
  /** Source label, used for resource source attribution. */
  name: AssetSourcePrecedence;
  /** Prompt-template (slash-command) folder relative to the scope root. */
  commands: string;
  /** Skills folder relative to the scope root. */
  skills: string;
}

const CLAUDE_SOURCE: CompatSource = { name: "claude", commands: ".claude/commands", skills: ".claude/skills" };
const CODEX_SOURCE: CompatSource = { name: "codex", commands: ".codex/prompts", skills: ".codex/skills" };

/** The configured Claude-vs-Codex precedence (`damocles.assetSourcePrecedence`, default `claude`). */
export function getAssetSourcePrecedence(): AssetSourcePrecedence {
  const value = vscode.workspace.getConfiguration("damocles").get<string>("assetSourcePrecedence", "claude");
  return value === "codex" ? "codex" : "claude";
}

/**
 * The compat asset sources ordered so the higher-precedence one comes first. Both discovery systems —
 * the pi resource loader (`additionalSkillPaths`/`additionalPromptTemplatePaths`) and the webview
 * `SlashCommandService` menu — iterate this same ordering with first-wins de-dup, so the agent's loaded
 * resources and the slash-command menu never desync. Source precedence is the primary sort; within each
 * source, callers scan project before user.
 */
export function compatSources(
  precedence: AssetSourcePrecedence = getAssetSourcePrecedence(),
): CompatSource[] {
  return precedence === "codex" ? [CODEX_SOURCE, CLAUDE_SOURCE] : [CLAUDE_SOURCE, CODEX_SOURCE];
}
