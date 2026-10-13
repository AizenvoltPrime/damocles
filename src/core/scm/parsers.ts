// Parsers ported from VS Code's git extension (extensions/git/src/git.ts, MIT, Copyright (c) Microsoft Corporation; see
// THIRD-PARTY-NOTICES.md). Behaviour kept; structure adapted.

export interface FileStatus {
  readonly x: string;
  readonly y: string;
  // the entry's path; for a rename or copy, the source
  readonly path: string;
  // for a rename or copy, the destination (git -z prints it first)
  readonly rename?: string;
}

/** `git status -z` porcelain v1, fed in chunks; an entry split across chunks waits for the rest. */
export class GitStatusParser {
  private lastRaw = '';
  private readonly result: FileStatus[] = [];

  get status(): FileStatus[] {
    return this.result;
  }

  update(raw: string): void {
    let i = 0;
    let next: number | undefined;
    raw = this.lastRaw + raw;
    while ((next = this.parseEntry(raw, i)) !== undefined) i = next;
    this.lastRaw = raw.slice(i);
  }

  private parseEntry(raw: string, i: number): number | undefined {
    if (i + 4 >= raw.length) return undefined;
    const x = raw.charAt(i++);
    const y = raw.charAt(i++);
    i++;
    let rename: string | undefined;
    let lastIndex: number;
    if (x === 'R' || y === 'R' || x === 'C') {
      lastIndex = raw.indexOf('\0', i);
      if (lastIndex === -1) return undefined;
      rename = raw.substring(i, lastIndex);
      i = lastIndex + 1;
    }
    lastIndex = raw.indexOf('\0', i);
    if (lastIndex === -1) return undefined;
    const path = raw.substring(i, lastIndex);
    // a path ending in a slash is a nested repository, which status lists as an untracked folder
    if (!path.endsWith('/')) this.result.push(rename === undefined ? { x, y, path } : { x, y, path, rename });
    return lastIndex + 1;
  }
}

interface GitConfigSection {
  readonly name: string;
  readonly subSectionName?: string;
  readonly properties: Record<string, string>;
}

const LINE_SEPARATOR = /\r?\n/;
const PROPERTY = /^\s*(\w+)\s*=\s*"?([^"]+)"?$/;
const SECTION = /^\s*\[\s*([^\]]+?)\s*("[^"]+")*\]\s*$/;

function parseGitConfig(raw: string): GitConfigSection[] {
  const sections: GitConfigSection[] = [];
  let section: GitConfigSection = { name: 'DEFAULT', properties: {} };
  for (const line of raw.split(LINE_SEPARATOR)) {
    const sectionMatch = SECTION.exec(line);
    if (sectionMatch?.length === 3) {
      sections.push(section);
      const subSectionName = sectionMatch[2]?.replaceAll('"', '');
      section = { name: sectionMatch[1]!, ...(subSectionName !== undefined ? { subSectionName } : {}), properties: {} };
      continue;
    }
    const propertyMatch = PROPERTY.exec(line);
    if (propertyMatch?.length === 3 && !Object.hasOwn(section.properties, propertyMatch[1]!)) section.properties[propertyMatch[1]!] = propertyMatch[2]!;
  }
  sections.push(section);
  return sections;
}

export interface Submodule {
  readonly name: string;
  // repository-controlled text: discovery confines it before using it
  readonly path: string;
  readonly url: string;
}

export function parseGitmodules(raw: string): Submodule[] {
  const result: Submodule[] = [];
  for (const section of parseGitConfig(raw).filter((candidate) => candidate.name === 'submodule')) {
    const path = section.properties['path'];
    const url = section.properties['url'];
    if (section.subSectionName && path && url) result.push({ name: section.subSectionName, path, url });
  }
  return result;
}

/**
 * The repository path git names when it refuses one for dubious ownership (VS Code's model.ts unsafeRepositoryMatch);
 * undefined for any other error.
 */
export function parseUnsafeRepository(stderr: string): string | undefined {
  const match = /^fatal: detected dubious ownership in repository at '([^']+)'[\s\S]*git config --global --add safe\.directory '?([^'\n]+)'?$/m.exec(stderr);
  return match?.[2]?.trim();
}

/** MERGE_MSG as the commit box shows it: git's comment lines dropped (VS Code's stripCommitMessageComments). */
export function stripCommitMessageComments(message: string): string {
  return message.replace(/^\s*#.*$\n?/gm, '').trim();
}
