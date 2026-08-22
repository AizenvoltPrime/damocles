import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { ASSET_SEGMENT_RE } from "../../shared/asset-names";
import { assetSourceDirs } from "../asset-sources";

function isValidSkillName(skillName: string): boolean {
  // The name goes into a path, so traversal is refused ahead of the alphabet check.
  if (!skillName || skillName.includes("..") || skillName.includes("/") || skillName.includes("\\")) {
    return false;
  }
  return ASSET_SEGMENT_RE.test(skillName);
}

export async function loadSkillDescription(skillName: string): Promise<string | undefined> {
  if (!isValidSkillName(skillName)) {
    return undefined;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const trusted = vscode.workspace.isTrusted;

  // A standalone reader rather than a call into SlashCommandService: the only caller is the permission
  // handler, which has no panel handle, and routing the gate through the chat panel would invert the
  // dependency direction.
  const skillPaths = assetSourceDirs("skills", { workspacePath, homeDir: os.homedir() })
    .filter((d) => trusted || d.scope !== "project")
    .map((d) => vscode.Uri.file(path.join(d.dir, skillName, "SKILL.md")));

  for (const skillPath of skillPaths) {
    try {
      const content = await vscode.workspace.fs.readFile(skillPath);
      const text = Buffer.from(content).toString("utf8");
      const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
      if (match && match[1]) {
        // Horizontal space only: `\s` spans the line break, so a blank `description:` would take the
        // next frontmatter line as its value. Same expression the menu scanner reads, so the approval
        // prompt and the menu describe a skill identically.
        const descMatch = match[1].match(/^description:[ \t]*(.+)$/m);
        const description = descMatch?.[1]?.trim();
        if (description) {
          return description;
        }
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
