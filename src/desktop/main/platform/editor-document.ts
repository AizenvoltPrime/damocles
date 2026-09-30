import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DiffSide } from '../../../platform/editor-service';
import { EDITOR_MAX_DOCUMENT_BYTES, type EditorDocument, type EditorDocumentBody } from '../../../shared/types/messages';

// Git's rule: a NUL byte in the first 8000 bytes marks the content binary.
const BINARY_SNIFF_BYTES = 8000;
// Read size once a file outgrows its stat.
const READ_CHUNK_BYTES = 64 * 1024;

// Must stay the set of Monaco languages the webview bundles (src/webview/components/editor/); anything else is 'plaintext'.
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json', '.code-workspace': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.svg': 'xml', '.xaml': 'xml', '.csproj': 'xml', '.plist': 'xml',
  '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h': 'cpp',
  '.c': 'c',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.bat': 'bat', '.cmd': 'bat',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.ini': 'ini', '.cfg': 'ini',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.lua': 'lua',
  '.dart': 'dart',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.scala': 'scala', '.sc': 'scala',
  '.r': 'r',
  '.pl': 'perl', '.pm': 'perl',
  '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp',
  '.vb': 'vb',
  '.proto': 'proto',
  '.tf': 'hcl', '.hcl': 'hcl',
  '.ex': 'elixir', '.exs': 'elixir',
};

const LANGUAGE_BY_FILE_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
};

const LANGUAGE_IDS: ReadonlySet<string> = new Set([...Object.values(LANGUAGE_BY_EXTENSION), 'plaintext']);

/** The Monaco language id for a file name, by exact name then extension; 'plaintext' when unknown. */
export function languageIdForName(name: string): string {
  const base = path.basename(name).toLowerCase();
  const byName = Object.hasOwn(LANGUAGE_BY_FILE_NAME, base) ? LANGUAGE_BY_FILE_NAME[base] : undefined;
  return byName ?? LANGUAGE_BY_EXTENSION[path.extname(base)] ?? 'plaintext';
}

/** A caller-supplied language id when the webview bundles it, else 'plaintext'. */
export function knownLanguageId(language: string): string {
  return LANGUAGE_IDS.has(language) ? language : 'plaintext';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tooLarge(bytes: number): EditorDocumentBody {
  return { kind: 'tooLarge', bytes, limitBytes: EDITOR_MAX_DOCUMENT_BYTES };
}

/** File bytes as the text VS Code shows: a UTF-8 or UTF-16 byte order mark picks the encoding and is not part of the text; undefined for binary. */
export function decodeText(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  const utf16 = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16.toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(utf16).swap16().toString('utf16le');
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString('utf8');
}

function bytesBody(bytes: Buffer, languageId: string): EditorDocumentBody {
  const content = decodeText(bytes);
  return content === undefined ? { kind: 'binary' } : { kind: 'text', content, languageId };
}

/** The body for in-memory text, under the same size and binary rules as a file. */
export function textBody(content: string, languageId: string): EditorDocumentBody {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > EDITOR_MAX_DOCUMENT_BYTES) return tooLarge(bytes);
  // Every character is at least one UTF-8 byte, so the first BINARY_SNIFF_BYTES bytes lie within as many characters.
  if (Buffer.from(content.slice(0, BINARY_SNIFF_BYTES), 'utf8').subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary' };
  return { kind: 'text', content, languageId };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

// A file over the limit is refused from its size before any content is read.
async function readBody(filePath: string, languageId: string): Promise<EditorDocumentBody | 'missing'> {
  try {
    // Stat before open: opening a FIFO blocks a libuv thread until a writer appears.
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { kind: 'unreadable', error: `${filePath} is not a file` };
    if (stat.size > EDITOR_MAX_DOCUMENT_BYTES) return tooLarge(stat.size);
  } catch (err) {
    return isMissing(err) ? 'missing' : { kind: 'unreadable', error: errorText(err) };
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    return isMissing(err) ? 'missing' : { kind: 'unreadable', error: errorText(err) };
  }
  try {
    // The path may have been replaced or grown since the stat; the read stops one byte past the limit.
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'unreadable', error: `${filePath} is not a file` };
    if (stat.size > EDITOR_MAX_DOCUMENT_BYTES) return tooLarge(stat.size);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(EDITOR_MAX_DOCUMENT_BYTES + 1 - total, Math.max(stat.size + 1 - total, READ_CHUNK_BYTES)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > EDITOR_MAX_DOCUMENT_BYTES) return tooLarge((await handle.stat()).size);
    }
    return bytesBody(Buffer.concat(chunks, total), languageId);
  } catch (err) {
    return { kind: 'unreadable', error: errorText(err) };
  } finally {
    await handle.close();
  }
}

/** Reads a file for display: a missing file is empty text. */
export async function fileBody(filePath: string, languageId: string): Promise<EditorDocumentBody> {
  const body = await readBody(filePath, languageId);
  return body === 'missing' ? { kind: 'text', content: '', languageId } : body;
}

/** A file's text under the same size, binary and encoding rules as a document; rejects when it is missing or cannot be shown as text. */
export async function readFileText(filePath: string): Promise<string> {
  const body = await readBody(filePath, 'plaintext');
  if (body === 'missing') throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' });
  if (body.kind === 'text') return body.content;
  if (body.kind === 'tooLarge') throw new Error(`${filePath} is ${body.bytes} bytes, over the ${body.limitBytes}-byte limit`);
  if (body.kind === 'binary') throw new Error(`${filePath} is a binary file`);
  throw new Error(body.error);
}

export async function fileDocument(filePath: string): Promise<EditorDocument> {
  return { name: path.basename(filePath), path: filePath, body: await fileBody(filePath, languageIdForName(filePath)) };
}

export function memoryDocument(name: string, content: string, languageId: string = languageIdForName(name)): EditorDocument {
  return { name, body: textBody(content, languageId) };
}

export function sideDocument(side: DiffSide): Promise<EditorDocument> {
  return 'path' in side ? fileDocument(side.path) : Promise.resolve(memoryDocument(side.name, side.content));
}
