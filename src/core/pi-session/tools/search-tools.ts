import { existsSync } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FindOperations, FindToolDetails, GrepToolDetails, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from './any-tool-definition';
import { processLauncher, type LaunchedProcess } from '../../process-launcher';
import type { PiCodingAgentModule } from '../pi-loader';
import { overrideRules } from './rg-ignore';
import { insideGitRepo, walkFiles } from './search-walk';

/**
 * Damocles' `grep` runs the ripgrep binary Damocles ships, and its `find` lists through the walk. pi's own
 * versions resolve `rg` and `fd` through its tools manager, which downloads them from GitHub into
 * `~/.pi/agent/bin` when they are not on PATH, and pi offers no option to name the binary.
 */
export type ResolveRgPath = () => Promise<string>;


/**
 * Per call, whether a `Read` deny or ask rule covers a file (`PermissionHandler.readRuleFilter`). The gate
 * blocks or asks for a search rooted at a covered path; a search rooted above one leaves its files out.
 */
export type ReadRuleFilter = () => Promise<(filePath: string) => boolean>;

const LEFT_OUT_NOTICE = 'Some files were left out because a Read rule in the user\'s permission settings covers them';

/** Every parameter `runGrep` handles; a pi schema with any other fails `search-tools.test.ts`. */
export const GREP_PARAMETER_NAMES = ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'] as const;

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

const GREP_DEFAULT_LIMIT = 100;
/** pi's `GREP_MAX_LINE_LENGTH`, the default `truncateLine` applies; named here for the notice text. */
const GREP_MAX_LINE_LENGTH = 500;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Git Bash, MSYS, Cygwin and WSL drive paths in the form native Windows APIs accept. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const [, drive = '', rest] = match;
  return `${drive.toUpperCase()}:\\${rest?.replaceAll('/', '\\') ?? ''}`;
}

function normalizeToolPath(input: string, stripPrefix: boolean): string {
  let normalized = stripPrefix ? input.replace(UNICODE_SPACES, ' ') : input;
  if (stripPrefix && normalized.startsWith('@')) normalized = normalized.slice(1);
  if (process.platform === 'win32') normalized = normalizeWindowsShellPath(normalized);
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    return path.join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** pi's `resolveToCwd` (`utils/paths.js` `resolvePath`), which its package does not export; keep the two in step. */
export function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = normalizeToolPath(filePath, true);
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(normalizeToolPath(cwd, false), normalized);
}

/** The paths pi's Read tries for `resolved`, in its order (`dist/core/tools/path-utils.js`), which its package does not export; keep the two in step. */
export function readPathCandidates(resolved: string): string[] {
  const nfd = resolved.normalize('NFD');
  return [...new Set([resolved, resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, resolved.replace(/'/g, '\u2019'), nfd.replace(/'/g, '\u2019')])];
}

/** pi's `resolveReadPath`, for the evaluator's synchronous rule match; a tool resolves with `resolveReadPathAsync`. */
export function resolveReadPath(resolved: string): string {
  return readPathCandidates(resolved).find((candidate) => existsSync(candidate)) ?? resolved;
}

/** pi's `resolveReadPathAsync`: `resolveReadPath` off the host thread, since a candidate on a share can block until SMB times out. */
export async function resolveReadPathAsync(resolved: string): Promise<string> {
  for (const candidate of readPathCandidates(resolved)) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return resolved;
}

function aborted(): Error {
  return new Error('Operation aborted');
}

/** rg prints an error for every file it cannot open, which can run to megabytes; the first ones name the cause. */
const STDERR_LIMIT = 8 * 1024;

function captureStderr(child: LaunchedProcess): () => string {
  let text = '';
  child.onData('stderr', (chunk) => {
    if (text.length < STDERR_LIMIT) text += chunk.toString().slice(0, STDERR_LIMIT - text.length);
  });
  return () => text;
}

/** pi 1.5.2's `decodeRgText` (`dist/core/tools/grep.js:31`): rg sends non-UTF-8 text base64-encoded in `bytes`. */
function decodeRgText(data: { text?: string; bytes?: string } | undefined): string {
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.bytes === 'string') return Buffer.from(data.bytes, 'base64').toString('utf-8');
  return '';
}

interface RgLineEvent {
  type?: string;
  data?: { path?: { text?: string; bytes?: string }; line_number?: number; absolute_offset?: number; lines?: { text?: string; bytes?: string }; binary_offset?: number | null };
}

// rg's read buffer (grep-searcher's DEFAULT_BUFFER_CAPACITY): its walk reports nothing from the buffer holding a file's first NUL on.
const BINARY_BUFFER = 64 * 1024;

/** How much of a file is known: `clean` bytes from its start hold no NUL, `nul` is the first one's offset, `end` that it was read whole. */
interface FileScan {
  clean: number;
  nul?: number;
  end: boolean;
}

/**
 * Reads file, a regular file the walk listed, from scan.clean on until `until`, its end or a NUL. rg decodes a file opening with a
 * UTF-16 byte order mark before it looks for a NUL, so such a file is read to its end or its first U+0000, which counts at offset 0.
 */
async function scanFile(file: string, scan: FileScan, until: number): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_BUFFER);
    if (scan.clean === 0) {
      const { bytesRead } = await handle.read(buffer, 0, 2, 0);
      const utf16 = bytesRead === 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : bytesRead === 2 && buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : undefined;
      if (utf16 !== undefined) {
        const decoder = new TextDecoder(utf16);
        for (let position = 2; ; ) {
          const { bytesRead: read } = await handle.read(buffer, 0, BINARY_BUFFER, position);
          if (decoder.decode(buffer.subarray(0, read), { stream: read > 0 }).includes('\0')) {
            scan.nul = 0;
            return;
          }
          if (read === 0) break;
          position += read;
        }
        scan.end = true;
        return;
      }
    }
    while (scan.clean < until) {
      const { bytesRead } = await handle.read(buffer, 0, BINARY_BUFFER, scan.clean);
      const nul = buffer.subarray(0, bytesRead).indexOf(0);
      if (nul >= 0) {
        scan.nul = scan.clean + nul;
        return;
      }
      scan.clean += bytesRead;
      if (bytesRead < BINARY_BUFFER) {
        scan.end = true;
        return;
      }
    }
  } finally {
    await handle.close();
  }
}

// The byte after an event's line, from where its line starts.
const lineEnd = (event: RgLineEvent): number => (event.data?.absolute_offset ?? 0) + (typeof event.data?.lines?.bytes === 'string' ? Buffer.from(event.data.lines.bytes, 'base64').length : Buffer.byteLength(event.data?.lines?.text ?? ''));

// A batch's whole rg command line in UTF-16 units, NUL included: headroom below CreateProcessW's 32,767, near which process
// creation stalls for seconds (measured, docs/invariants.md "Tool overrides").
const BATCH_COMMAND_LINE = 32000;

/** The length libuv gives arg on a Windows command line (`quote_cmd_arg`): quoted when it holds a space, tab or `"`, or is empty. */
export function commandLineLength(arg: string): number {
  if (arg === '') return 2;
  if (!/[ \t"]/.test(arg)) return arg.length;
  if (!/["\\]/.test(arg)) return arg.length + 2;
  let extra = 2;
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    // backslashes before a quote are doubled, and the quote is escaped
    if (char === '"') extra += backslashes + 1;
    backslashes = 0;
  }
  // and so are those before the closing quote
  return arg.length + extra + backslashes;
}

async function runGrep(
  pi: PiCodingAgentModule,
  rgPath: string,
  cwd: string,
  params: GrepParams,
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
  allowedHosts: () => Promise<ReadonlySet<string>>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: GrepToolDetails | undefined }> {
  const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params;
  const searchPath = resolveToCwd(searchDir || '.', cwd);
  const coveredFiles = new Map<string, boolean>();
  let leftOut = false;
  const isCovered = (filePath: string): boolean => {
    let value = coveredFiles.get(filePath);
    if (value === undefined) {
      value = covered(path.resolve(searchPath, filePath));
      coveredFiles.set(filePath, value);
    }
    return value;
  };
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(searchPath)).isDirectory();
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }
  if (signal?.aborted) throw aborted();
  // Clamped as pi 1.5.2 does (`dist/core/tools/grep.js:77-78`), so String() never gives exponent notation, which rg rejects.
  const contextValue = context && context > 0 ? Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER) : 0;
  const effectiveLimit = Math.max(1, Math.floor(limit ?? GREP_DEFAULT_LIMIT));
  const formatPath = (filePath: string): string => {
    if (isDirectory) {
      const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
      if (relative && !relative.startsWith('..')) return relative.replace(/\\/g, '/');
    }
    return path.basename(filePath);
  };

  // --no-config, as in pi's grep: a RIPGREP_CONFIG_PATH file must not change what the tool's options mean.
  const args = ['--no-config', '--json', '--line-number', '--color=never', '--hidden'];
  if (ignoreCase) args.push('--ignore-case');
  if (literal) args.push('--fixed-strings');
  if (contextValue > 0) args.push('--context', String(contextValue));
  // rg never matches a glob starting with `./`; a leading `!` still negates.
  const globLine = glob ? glob.replace(/^(!?)(?:\.\/)+/, '$1') : undefined;

  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;
  const outputLines: string[] = [];
  // The whole output's size, a newline counted after every line; lines past the byte cap are counted, not kept.
  let outputBytes = 0;
  let outputLineCount = 0;
  const pushLine = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean): void => {
    // Only the line terminator goes: a lone CR inside a line is content.
    const { text, wasTruncated } = pi.truncateLine(lineText.replace(/\r?\n?$/, ''));
    if (wasTruncated) linesTruncated = true;
    const relativePath = formatPath(filePath);
    const line = isMatch ? `${relativePath}:${lineNumber}: ${text}` : `${relativePath}-${lineNumber}- ${text}`;
    if (outputBytes - 1 <= pi.DEFAULT_MAX_BYTES) outputLines.push(line);
    outputBytes += Buffer.byteLength(line, 'utf-8') + 1;
    outputLineCount++;
  };

  // pi 1.5.2's limit window (`dist/core/tools/grep.js:139-204`): rg still sends the last allowed match's
  // trailing context, and only one more match proves that the limit cut results off. It spans rg's runs.
  let lastFile: string | undefined;
  let limitHit = false;
  let trailingContextEnd = 0;
  let done = false;
  const onEvent = (event: RgLineEvent): void => {
    if (done) return;
    const isMatch = event.type === 'match';
    if (!isMatch && event.type !== 'context') return;
    const filePath = decodeRgText(event.data?.path);
    const lineNumber = event.data?.line_number;
    if (!filePath || typeof lineNumber !== 'number') return;
    if (isCovered(filePath)) {
      if (!limitHit) leftOut = true;
      return;
    }
    const lineText = decodeRgText(event.data?.lines);
    if (!limitHit) {
      lastFile = filePath;
      pushLine(filePath, lineNumber, lineText, isMatch);
      if (!isMatch) return;
      matchCount++;
      if (matchCount >= effectiveLimit) {
        limitHit = true;
        trailingContextEnd = lineNumber + contextValue;
      }
      return;
    }
    const inWindow = filePath === lastFile && lineNumber <= trailingContextEnd;
    // A match inside the last match's trailing context shows as context.
    if (inWindow) pushLine(filePath, lineNumber, lineText, false);
    if (isMatch) matchLimitReached = true;
    if (matchLimitReached && !(inWindow && lineNumber < trailingContextEnd)) done = true;
  };

  let killedDueToLimit = false;
  // walked: rg searches the files the walk listed, each named on its command line, and so past a NUL, where its own walk
  // reports nothing from the read buffer holding the NUL on (64 KiB, BINARY_BUFFER); a file's events are held until its end,
  // or, once they would end the search or pass the output cap, until a read of the file shows no NUL up to their buffers.
  const search = (rgArgs: readonly string[], walked: boolean): Promise<void> => new Promise<void>((resolve, reject) => {
    // an aborted signal fires no abort event, so a run started after the abort would go to its end
    if (signal?.aborted) return reject(aborted());
    const child = processLauncher().launch({ file: rgPath, args: rgArgs, ...(isDirectory ? { cwd: searchPath } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = captureStderr(child);
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let file: { path: string; held: RgLineEvent[]; matches: number; bytes: number; scan: FileScan; mode: 'hold' | 'stream' | 'drop' } | undefined;
    // lines that arrive while a file's first buffer is read wait here, in order
    let waiting: string[] | undefined;
    let checking: Promise<void> = Promise.resolve();
    let failure: { error: unknown } | undefined;
    const stopIfDone = (): void => {
      if (done && !killedDueToLimit) {
        killedDueToLimit = true;
        child.kill();
      }
    };
    const onFileEvent = (event: RgLineEvent): void => {
      if (event.type === 'begin') {
        file = { path: decodeRgText(event.data?.path), held: [], matches: 0, bytes: 0, scan: { clean: 0, end: false }, mode: 'hold' };
        return;
      }
      if (file === undefined) return;
      if (event.type === 'end') {
        const binaryOffset = event.data?.binary_offset;
        if (file.mode === 'hold') {
          const before = binaryOffset == null ? Infinity : binaryOffset - BINARY_BUFFER;
          for (const kept of file.held) if (lineEnd(kept) <= before) onEvent(kept);
        }
        file = undefined;
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') return;
      if (file.mode === 'stream') return onEvent(event);
      if (file.mode === 'drop') return;
      file.held.push(event);
      if (event.type === 'match') file.matches++;
      file.bytes += decodeRgText(event.data?.lines).length;
      // once the hold would end the search or outgrow the output cap, the file is read far enough to release it
      if ((event.type === 'match' && matchCount + file.matches > effectiveLimit) || file.bytes > pi.DEFAULT_MAX_BYTES) {
        const checked = file;
        waiting = [];
        const until = checked.held.reduce((last, kept) => Math.max(last, kept.data?.absolute_offset ?? 0), 0) + BINARY_BUFFER;
        checking = scanFile(path.resolve(searchPath, checked.path), checked.scan, until).then(() => {
          const { nul, end, clean } = checked.scan;
          // a line shows when no buffer up to its own holds a NUL: rg's walk stops at the buffer holding the first one
          const shows = (kept: RgLineEvent): boolean => (nul !== undefined ? lineEnd(kept) <= nul - BINARY_BUFFER : end || (kept.data?.absolute_offset ?? 0) + BINARY_BUFFER <= clean);
          const released = checked.held.filter(shows);
          checked.held = nul !== undefined || end ? [] : checked.held.filter((kept) => !shows(kept));
          checked.matches = checked.held.filter((kept) => kept.type === 'match').length;
          checked.bytes = checked.held.reduce((sum, kept) => sum + decodeRgText(kept.data?.lines).length, 0);
          if (nul !== undefined) checked.mode = 'drop';
          else if (end) checked.mode = 'stream';
          for (const kept of released) onEvent(kept);
          const queued = waiting ?? [];
          waiting = undefined;
          stopIfDone();
          for (const line of queued) onLine(line);
        }, (error: unknown) => {
          failure = { error };
          waiting = undefined;
          child.kill();
        });
      }
    };
    const onLine = (line: string): void => {
      if (waiting) return void waiting.push(line);
      if (done || !line.trim()) return;
      let event: RgLineEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (walked) onFileEvent(event);
      else onEvent(event);
      stopIfDone();
    };
    child.onData('stdout', (chunk) => {
      const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    Promise.all([child.exited, child.closed]).then(async ([{ code }]) => {
      onLine(pending + decoder.end());
      // a check started by the last lines settles before the run does
      for (let settled = checking; ; settled = checking) {
        await settled;
        if (settled === checking) break;
      }
      signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure.error);
      if (signal?.aborted) return reject(aborted());
      if (!killedDueToLimit && code !== 0 && code !== 1) return reject(new Error(stderr().trim() || `ripgrep exited with code ${code}`));
      resolve();
    }, (error: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
  });

  if (!isDirectory) {
    // a file named on rg's command line is searched whatever --glob says
    await search([...args, ...(globLine ? ['--glob', globLine] : []), '--', pattern, searchPath], false);
  } else {
    // --no-ignore: rg reads no ignore file, git folder or git config for the files it is given; --no-mmap: every file is read
    // as rg's own walk reads it, whatever the batch's size
    const fixed = [...args, '--no-ignore', '--no-mmap', '--', pattern];
    const fixedLength = [rgPath, ...fixed].reduce((sum, arg) => sum + commandLineLength(arg) + 1, 0);
    const walk = walkFiles({ root: searchPath, requireGit: true, overrides: overrideRules(globLine ? [globLine] : []), allowedHosts, signal });
    let batch: string[] = [];
    let length = fixedLength;
    // one rg at a time, searching its batch on its own threads, while the walk goes on
    let running: Promise<void> = Promise.resolve();
    let failure: { error: unknown } | undefined;
    const start = (files: string[]): void => {
      running = search([...fixed, ...files], true).catch((error: unknown) => {
        failure = { error };
      });
    };
    try {
      for await (const file of walk.files) {
        const cost = commandLineLength(file) + 1;
        if (length + cost > BATCH_COMMAND_LINE && batch.length > 0) {
          await running;
          if (failure || done) break;
          start(batch);
          batch = [];
          length = fixedLength;
        }
        batch.push(file);
        length += cost;
      }
      await running;
      if (!failure && !done && batch.length > 0) start(batch);
    } finally {
      // a walk that fails leaves its rg to finish (an abort kills it) before the error reaches the caller
      await running;
    }
    if (failure) throw failure.error;
    if (!killedDueToLimit && walk.errors.length > 0) throw new Error(walk.errors.join('\n'));
  }

  if (matchCount === 0) return { content: [{ type: 'text', text: leftOut ? `No matches found\n\n[${LEFT_OUT_NOTICE}]` : 'No matches found' }], details: undefined };

  const truncation = pi.truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  truncation.totalLines = outputLineCount;
  truncation.totalBytes = outputBytes - 1;
  let output = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (leftOut) notices.push(LEFT_OUT_NOTICE);
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
  return { content: [{ type: 'text', text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/**
 * pi's `grep` (name, schema, description, renderers) with an `execute` that runs the bundled rg as pi runs its own: on a file
 * named by `path` itself, else on the files the walk lists (`walkFiles`). allowedNetworkHosts: the chat's hosts, onto which a
 * `.git` file's pointer may lead.
 */
export function createGrepTool(pi: PiCodingAgentModule, cwd: string, resolveRgPath: ResolveRgPath, readRuleFilter: ReadRuleFilter, allowedNetworkHosts: () => Promise<ReadonlySet<string>>): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createGrepToolDefinition(cwd);
  return {
    ...metadata,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (signal?.aborted) throw aborted();
      return runGrep(pi, await resolveRgPath(), ctx?.cwd || cwd, params as GrepParams, signal, await readRuleFilter(), allowedNetworkHosts);
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

/**
 * fd's `--glob` matching as pi's `find` drives it: smart case, dotfiles included, a pattern without
 * `/` matched against the name, one with `/` against the full path with `**\/` in front unless it is
 * anchored or already starts with it. On Windows `\` is a separator, elsewhere an escape
 * (pi 1.5.2 `dist/core/tools/find.js:156`).
 */
export function fdGlobMatcher(rawPattern: string): (absolutePath: string) => boolean {
  const separated = process.platform === 'win32' ? rawPattern.replaceAll('\\', '/') : rawPattern;
  // fd reads `(`, `)` and `|` literally, where picomatch would build a regex group from them.
  const pattern = separated.replace(/\\.|[()|]/g, (token) => (token.length === 2 ? token : `\\${token}`));
  // fd's glob dialect has no leading-`!` negation and no extglobs; `[!a]` negates a class (`posix`), and `[ab]` is only a class.
  const options = {
    dot: true,
    nocase: pattern === pattern.toLowerCase(),
    windows: false,
    nonegate: true,
    noextglob: true,
    posix: true,
    literalBrackets: false,
  };
  // makeRe, since picomatch's own matcher also accepts a name equal to the pattern text.
  if (!pattern.includes('/')) {
    const matches = picomatch.makeRe(pattern, options);
    return (absolutePath) => matches.test(path.basename(absolutePath));
  }
  const anchored = pattern.startsWith('/') || pattern.startsWith('**/') || pattern === '**' || path.isAbsolute(pattern);
  // picomatch's `dir/**` also matches `dir` itself and fd's does not (pi 1.5.2 `dist/core/tools/find.js:171`).
  const fdPattern = pattern.replace(/\/\*\*$/, '/**/*');
  const matches = picomatch.makeRe(anchored ? fdPattern : `**/${fdPattern}`, options);
  return (absolutePath) => matches.test(toPosix(absolutePath));
}

/**
 * Every file under `searchPath` that `pattern` matches, and every directory holding a listed file,
 * up to `limit`, directories with a trailing separator. The walk lists the files; the pattern is
 * applied here because an rg `--glob` include overrides `.gitignore`, which fd's never does. Unlike
 * fd, it reports no empty directory, no directory whose files are all ignored, and no symlink.
 */
async function listMatchingPaths(
  pattern: string,
  searchPath: string,
  options: { ignore: string[]; limit: number },
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
  onLeftOut: () => void,
  allowedHosts: () => Promise<ReadonlySet<string>>,
): Promise<string[]> {
  if (!(await stat(searchPath)).isDirectory()) throw new Error(`Search path is not a directory: ${searchPath}`);
  if (options.limit <= 0) return [];
  if (signal?.aborted) throw aborted();
  // fd applies .gitignore outside a repository only with --no-require-git, and pi passes it there.
  const requireGit = await insideGitRepo(searchPath);
  // pi's node_modules and .git excludes match the path below the search root, so a root inside either still lists.
  const walk = walkFiles({ root: searchPath, requireGit, overrides: overrideRules(options.ignore.map((glob) => `!${glob}`)), allowedHosts, signal });
  const matches = fdGlobMatcher(pattern);
  const seenDirectories = new Set<string>();
  const results: string[] = [];
  let listedAny = false;
  const add = (entry: string): void => {
    if (results.length < options.limit) results.push(entry);
  };
  for await (const entry of walk.files) {
    listedAny = true;
    const file = path.join(searchPath, entry);
    const relative = path.dirname(entry);
    if (relative !== '.') {
      let directory = searchPath;
      for (const segment of relative.split(path.sep)) {
        directory = path.join(directory, segment);
        if (seenDirectories.has(directory)) continue;
        seenDirectories.add(directory);
        if (matches(directory)) add(directory + path.sep);
      }
    }
    if (matches(file)) {
      if (covered(file)) onLeftOut();
      else add(file);
    }
    if (results.length >= options.limit) break;
  }
  // a folder that could not be read is a partial walk; with nothing listed it is the answer
  if (!listedAny && walk.errors.length > 0) throw new Error(walk.errors.join('\n'));
  return results;
}

function walkFindOperations(
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
  onLeftOut: () => void,
  allowedHosts: () => Promise<ReadonlySet<string>>,
): FindOperations {
  return {
    exists,
    glob: (pattern, searchPath, options) => listMatchingPaths(pattern, searchPath, options, signal, covered, onLeftOut, allowedHosts),
  };
}

/** pi 1.5.2's hook branch (`dist/core/tools/find.js:107`) drops the retry hint its fd branch gives (`find.js:264`); this puts it back. */
function withLimitHint(result: AgentToolResult<FindToolDetails | undefined>): AgentToolResult<FindToolDetails | undefined> {
  const limit = result.details?.resultLimitReached;
  if (limit === undefined) return result;
  const notice = `${limit} results limit reached`;
  const hinted = `${notice}. Use limit=${limit * 2} for more, or refine pattern`;
  return {
    ...result,
    content: result.content.map((block) => (block.type === 'text' ? { ...block, text: block.text.replace(notice, hinted) } : block)),
  };
}

/** pi's `find` driven through its `operations.glob` hook, built per call so the listing sees the call's abort signal. */
export function createFindTool(pi: PiCodingAgentModule, cwd: string, readRuleFilter: ReadRuleFilter, allowedNetworkHosts: () => Promise<ReadonlySet<string>>): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createFindToolDefinition(cwd);
  return {
    ...metadata,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      let leftOut = false;
      const operations = walkFindOperations(signal, await readRuleFilter(), () => { leftOut = true; }, allowedNetworkHosts);
      const find: AnyToolDefinition = pi.createFindToolDefinition(cwd, { operations });
      const result = withLimitHint(await find.execute(toolCallId, params, signal, onUpdate, ctx));
      if (!leftOut) return result;
      return { ...result, content: [...result.content, { type: 'text', text: `\n\n[${LEFT_OUT_NOTICE}]` }] };
    },
  };
}
