import { diffLines, type Change } from 'diff';

export interface DiffLine {
  oldLineNum: number | null;
  newLineNum: number | null;
  type: 'context' | 'addition' | 'deletion' | 'gap';
  content: string;
  hiddenCount?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  stats: {
    added: number;
    removed: number;
  };
}

const MAX_DIFF_LINES = 1000;

export function computeDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return computeSimpleDiff(oldLines, newLines);
  }

  const changes = diffLines(oldText, newText);
  return processChanges(changes);
}

function processChanges(changes: Change[]): DiffResult {
  const lines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let addedCount = 0;
  let removedCount = 0;

  for (const change of changes) {
    const changeLines = change.value.split('\n');
    if (changeLines[changeLines.length - 1] === '') {
      changeLines.pop();
    }

    for (const content of changeLines) {
      if (change.added) {
        lines.push({
          oldLineNum: null,
          newLineNum: newLineNum++,
          type: 'addition',
          content,
        });
        addedCount++;
      } else if (change.removed) {
        lines.push({
          oldLineNum: oldLineNum++,
          newLineNum: null,
          type: 'deletion',
          content,
        });
        removedCount++;
      } else {
        lines.push({
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
          type: 'context',
          content,
        });
      }
    }
  }

  return {
    lines,
    stats: { added: addedCount, removed: removedCount },
  };
}

function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffResult {
  const lines: DiffLine[] = [];

  lines.push({
    oldLineNum: null,
    newLineNum: null,
    type: 'gap',
    content: '',
    hiddenCount: oldLines.length,
  });

  for (const [i, content] of oldLines.entries()) {
    lines.push({
      oldLineNum: i + 1,
      newLineNum: null,
      type: "deletion",
      content,
    });
  }

  lines.push({
    oldLineNum: null,
    newLineNum: null,
    type: 'gap',
    content: '',
    hiddenCount: 0,
  });

  for (const [i, content] of newLines.entries()) {
    lines.push({
      oldLineNum: null,
      newLineNum: i + 1,
      type: "addition",
      content,
    });
  }

  return {
    lines,
    stats: { added: newLines.length, removed: oldLines.length },
  };
}

export function computeNewFileOnlyDiff(content: string): DiffResult {
  const contentLines = content.split('\n');
  const lines: DiffLine[] = contentLines.map((line, i) => ({
    oldLineNum: null,
    newLineNum: i + 1,
    type: 'addition' as const,
    content: line,
  }));

  return {
    lines,
    stats: { added: contentLines.length, removed: 0 },
  };
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  const extensionMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    vue: 'vue',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    swift: 'swift',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    dockerfile: 'docker',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    gitignore: 'gitignore',
  };

  return extensionMap[ext] || 'txt';
}
