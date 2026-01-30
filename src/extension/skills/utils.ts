import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

function isValidSkillName(skillName: string): boolean {
  if (!skillName || skillName.includes("..") || skillName.includes("/") || skillName.includes("\\")) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(skillName);
}

export async function loadSkillDescription(skillName: string): Promise<string | undefined> {
  if (!isValidSkillName(skillName)) {
    return undefined;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const homeDir = os.homedir();

  const skillPaths: vscode.Uri[] = [];

  if (workspaceFolders && workspaceFolders.length > 0) {
    const firstFolder = workspaceFolders[0];
    if (firstFolder) {
      skillPaths.push(
        vscode.Uri.joinPath(firstFolder.uri, ".claude", "skills", skillName, "SKILL.md")
      );
    }
  }
  skillPaths.push(
    vscode.Uri.file(path.join(homeDir, ".claude", "skills", skillName, "SKILL.md"))
  );

  for (const skillPath of skillPaths) {
    try {
      const content = await vscode.workspace.fs.readFile(skillPath);
      const text = Buffer.from(content).toString("utf8");
      const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
      if (match && match[1]) {
        const descMatch = match[1].match(/description:\s*(.+)/);
        if (descMatch && descMatch[1]) {
          return descMatch[1].trim();
        }
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
