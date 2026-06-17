import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { CustomAgentInfo } from "../shared/types/commands";
import { log } from "./logger";

const AGENTS_FOLDER = ".claude/agents";
const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

interface ParsedAgentFile {
  description: string;
  model?: string;
  tools?: string[];
}

export class CustomAgentService {
  private cache: CustomAgentInfo[] | null = null;
  private projectWatcher: vscode.FileSystemWatcher | null = null;
  private userWatcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private onCacheInvalidate?: () => void;

  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.setupFileWatchers();
  }

  setOnCacheInvalidate(callback: () => void): void {
    this.onCacheInvalidate = callback;
  }

  private setupFileWatchers(): void {
    const invalidateCache = () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.cache = null;
        log("Custom agent cache invalidated due to file change");
        this.onCacheInvalidate?.();
      }, 300);
    };

    const projectPattern = new vscode.RelativePattern(
      this.workspacePath,
      `${AGENTS_FOLDER}/**/*.md`
    );
    this.projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
    this.projectWatcher.onDidCreate(invalidateCache);
    this.projectWatcher.onDidChange(invalidateCache);
    this.projectWatcher.onDidDelete(invalidateCache);

    const userAgentsPath = path.join(os.homedir(), AGENTS_FOLDER);
    const userPattern = `${userAgentsPath.replace(/\\/g, "/")}/**/*.md`;
    this.userWatcher = vscode.workspace.createFileSystemWatcher(userPattern);
    this.userWatcher.onDidCreate(invalidateCache);
    this.userWatcher.onDidChange(invalidateCache);
    this.userWatcher.onDidDelete(invalidateCache);
  }

  async getCustomAgents(): Promise<CustomAgentInfo[]> {
    if (this.cache) {
      return this.cache;
    }

    const agents: CustomAgentInfo[] = [];

    const projectAgentsDir = path.join(this.workspacePath, AGENTS_FOLDER);
    const projectAgents = await this.scanDirectory(projectAgentsDir, "project");
    agents.push(...projectAgents);

    const userAgentsDir = path.join(os.homedir(), AGENTS_FOLDER);
    const userAgents = await this.scanDirectory(userAgentsDir, "user");

    for (const userAgent of userAgents) {
      const exists = agents.some((a) => a.name === userAgent.name);
      if (!exists) {
        agents.push(userAgent);
      }
    }

    agents.sort((a, b) => a.name.localeCompare(b.name));

    this.cache = agents;
    return agents;
  }

  private async scanDirectory(
    dir: string,
    source: "project" | "user"
  ): Promise<CustomAgentInfo[]> {
    const agents: CustomAgentInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return agents;
    }

    const rootAgents = await this.scanDirectoryFiles(dir, source);
    agents.push(...rootAgents);

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subdir = path.join(dir, entry.name);
          const subdirAgents = await this.scanDirectoryFiles(subdir, source);
          agents.push(...subdirAgents);
        }
      }
    } catch (err) {
      log(`Error scanning subdirectories in ${dir}: ${err}`);
    }

    return agents;
  }

  private async scanDirectoryFiles(
    dir: string,
    source: "project" | "user"
  ): Promise<CustomAgentInfo[]> {
    const agents: CustomAgentInfo[] = [];

    try {
      const files = await fs.promises.readdir(dir);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const agentName = file.replace(/\.md$/, "");
        if (!VALID_AGENT_NAME.test(agentName)) {
          log(`Skipping invalid agent name: ${agentName}`);
          continue;
        }

        const filePath = path.join(dir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const parsed = this.parseAgentFile(content);

          agents.push({
            name: agentName,
            description: parsed.description,
            source,
            ...(parsed.model !== undefined ? { model: parsed.model } : {}),
            ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
          });
        } catch (err) {
          log(`Error reading agent file ${filePath}: ${err}`);
        }
      }
    } catch (err) {
      log(`Error scanning directory ${dir}: ${err}`);
    }

    return agents;
  }

  private parseAgentFile(content: string): ParsedAgentFile {
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1] ?? "";
      const body = frontmatterMatch[2] ?? "";

      const trimmedBody = body.trim();
      let description = "";
      let model: string | undefined;
      let tools: string[] | undefined;

      const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descriptionMatch?.[1]) {
        description = descriptionMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      const modelMatch = frontmatter.match(/^model:\s*(.+)$/m);
      if (modelMatch?.[1]) {
        model = modelMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      const toolsArrayMatch = frontmatter.match(/^tools:\s*\[([^\]]*)\]$/m);
      const toolsCommaMatch = frontmatter.match(/^tools:\s*([^[\n]+)$/m);
      if (toolsArrayMatch) {
        const inner = toolsArrayMatch[1] ?? "";
        tools = inner
          ? inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
          : [];
      } else if (toolsCommaMatch?.[1]) {
        tools = toolsCommaMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }

      if (!description) {
        description = this.extractFirstLine(trimmedBody);
      }

      return {
        description,
        ...(model !== undefined ? { model } : {}),
        ...(tools !== undefined ? { tools } : {}),
      };
    }

    const description = this.extractFirstLine(content.trim());
    return { description };
  }

  private extractFirstLine(content: string): string {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return this.stripMarkdownFormatting(trimmed).slice(0, 100);
      }
    }
    return "No description";
  }

  private stripMarkdownFormatting(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/(^|\s)__(.+?)__(?=\s|$)/g, "$1$2")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }

  dispose(): void {
    if (this.projectWatcher) {
      this.projectWatcher.dispose();
      this.projectWatcher = null;
    }
    if (this.userWatcher) {
      this.userWatcher.dispose();
      this.userWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
