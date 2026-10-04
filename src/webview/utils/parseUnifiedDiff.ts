import { diffLines, parsePatch } from 'diff';
import type { ToolCall } from '@shared/types/session';
import type { FilePatchOmitted } from '@shared/types/file-patch';
import type { PendingPermissionInfo } from '@shared/types/permissions';

export interface DiffLine {
  oldLineNum: number | null;
  newLineNum: number | null;
  /** `gap` stands for the unchanged lines between two hunks; `noNewline` marks the line above as the file's last, without a line end. */
  type: 'context' | 'addition' | 'deletion' | 'gap' | 'noNewline';
  content: string;
  hiddenCount?: number;
}

export interface FileDiff {
  lines: DiffLine[];
  /** False when nothing says where the lines are in the file, so the view shows no line numbers. */
  numbered: boolean;
  stats: { added: number; removed: number };
  /** Set when the change recorded no patch, and the view says why instead of showing lines. */
  omitted?: FilePatchOmitted;
  /** Set when there are no lines to show: a new file with no content, or a change that changes nothing. */
  empty?: 'emptyFile' | 'noChanges';
}

/**
 * Where a file change's diff comes from. Only a recorded patch and a new file's own lines carry real
 * line numbers; a `change` is the text the tool was asked to replace, which no file position backs.
 */
export type FileDiffSource =
  | { kind: 'patch'; patch: string }
  | { kind: 'newFile'; content: string }
  | { kind: 'change'; oldText: string; newText: string }
  | { kind: 'omitted'; reason: FilePatchOmitted };

/** Above this, a numberless change is shown as removed then added rather than diffed in the webview. */
const MAX_CHANGE_DIFF_LINES = 1000;

/** Whether jsdiff can read the patch; it throws on a stray line, a wrong hunk count or a header split by a newline. */
function parses(patch: string): boolean {
  try {
    parsePatch(patch);
    return true;
  } catch {
    return false;
  }
}

/** A recorded patch that parses, or the reason none was recorded, from a tool result's metadata or an approval. */
function recordedSource(record: { patch?: unknown; patchOmitted?: unknown } | undefined): FileDiffSource | null {
  if (typeof record?.patch === 'string') return parses(record.patch) ? { kind: 'patch', patch: record.patch } : null;
  if (record?.patchOmitted === 'tooLarge' || record?.patchOmitted === 'binary') return { kind: 'omitted', reason: record.patchOmitted };
  return null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The diff an Edit or Write card and the diff it opens render. The result's recorded patch comes first,
 * then a Write's record that it created its file; while the call awaits approval, the approval's patch,
 * or a new file's lines. Anything else shows the requested change without line numbers.
 */
export function fileChangeSource(toolCall: Pick<ToolCall, 'name' | 'input' | 'status' | 'metadata'>, approval: Pick<PendingPermissionInfo, 'patch' | 'patchOmitted'> | undefined): FileDiffSource {
  const isWrite = toolCall.name === 'Write';
  const content = text(toolCall.input['content']);
  const recorded = recordedSource(toolCall.metadata);
  if (recorded) return recorded;
  if (isWrite && toolCall.metadata?.['created'] === true) return { kind: 'newFile', content };
  if (toolCall.status === 'awaiting_approval' && approval) {
    const pending = recordedSource(approval);
    if (pending) return pending;
    // An approval carries a patch or its omission for every file that exists, so a Write with neither creates its file.
    if (isWrite && approval.patch === undefined) return { kind: 'newFile', content };
  }
  if (isWrite) return { kind: 'change', oldText: '', newText: content };
  return { kind: 'change', oldText: text(toolCall.input['old_string']), newText: text(toolCall.input['new_string']) };
}

/** Lines of `content`, without the empty string a final line end leaves after it. */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function fromPatch(patch: string): FileDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let previousOldEnd: number | null = null;
  for (const hunk of parsePatch(patch)[0]?.hunks ?? []) {
    if (previousOldEnd !== null) {
      lines.push({ oldLineNum: null, newLineNum: null, type: 'gap', content: '', hiddenCount: hunk.oldStart - previousOldEnd });
    }
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const content = raw.slice(1);
      switch (raw[0]) {
        case '+':
          lines.push({ oldLineNum: null, newLineNum: newLine++, type: 'addition', content });
          added++;
          break;
        case '-':
          lines.push({ oldLineNum: oldLine++, newLineNum: null, type: 'deletion', content });
          removed++;
          break;
        case '\\':
          lines.push({ oldLineNum: null, newLineNum: null, type: 'noNewline', content: '' });
          break;
        default:
          lines.push({ oldLineNum: oldLine++, newLineNum: newLine++, type: 'context', content });
      }
    }
    previousOldEnd = hunk.oldStart + hunk.oldLines;
  }
  return { lines, numbered: true, stats: { added, removed } };
}

function fromNewFile(content: string): FileDiff {
  const lines = splitLines(content).map((line, i): DiffLine => ({ oldLineNum: null, newLineNum: i + 1, type: 'addition', content: line }));
  return { lines, numbered: true, stats: { added: lines.length, removed: 0 } };
}

function fromChange(oldText: string, newText: string): FileDiff {
  const removedLines = splitLines(oldText);
  const addedLines = splitLines(newText);
  const unnumbered = (type: DiffLine['type'], content: string): DiffLine => ({ oldLineNum: null, newLineNum: null, type, content });
  if (removedLines.length > MAX_CHANGE_DIFF_LINES || addedLines.length > MAX_CHANGE_DIFF_LINES) {
    return {
      lines: [...removedLines.map((line) => unnumbered('deletion', line)), ...addedLines.map((line) => unnumbered('addition', line))],
      numbered: false,
      stats: { added: addedLines.length, removed: removedLines.length },
    };
  }
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    const type = part.added ? 'addition' : part.removed ? 'deletion' : 'context';
    for (const line of splitLines(part.value)) lines.push(unnumbered(type, line));
    if (part.added) added += part.count;
    if (part.removed) removed += part.count;
  }
  return { lines, numbered: false, stats: { added, removed } };
}

export function buildFileDiff(source: FileDiffSource): FileDiff {
  const diff = linesOf(source);
  if (diff.lines.length > 0 || diff.omitted) return diff;
  // A patch without hunks changes nothing; any other source without lines is a Write of no content.
  return { ...diff, empty: source.kind === 'patch' ? 'noChanges' : 'emptyFile' };
}

function linesOf(source: FileDiffSource): FileDiff {
  switch (source.kind) {
    case 'patch':
      return fromPatch(source.patch);
    case 'newFile':
      return fromNewFile(source.content);
    case 'change':
      return fromChange(source.oldText, source.newText);
    case 'omitted':
      return { lines: [], numbered: false, stats: { added: 0, removed: 0 }, omitted: source.reason };
  }
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
