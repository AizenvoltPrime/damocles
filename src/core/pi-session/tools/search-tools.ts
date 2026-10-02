import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'child_process';
import picomatch from 'picomatch';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FindOperations, FindToolDetails, GrepToolDetails, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';

/**
 * Damocles' `grep` and `find` run the ripgrep binary Damocles ships. pi's own versions resolve `rg`
 * and `fd` through its tools manager, which downloads them from GitHub into `~/.pi/agent/bin` when
 * they are not on PATH, and pi offers no option to name the binary.
 */
export type ResolveRgPath = () => Promise<string>;

/** pi's definitions carry their own schema and render types; only the erased shape is assignable both ways. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

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

interface GrepMatch {
  filePath: string;
  lineNumber: number;
  lineText: string | undefined;
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

function aborted(): Error {
  return new Error('Operation aborted');
}

/** A walk from a drive root can print megabytes of access errors; the first ones name the cause. */
const STDERR_LIMIT = 8 * 1024;

function captureStderr(stream: NodeJS.ReadableStream): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    if (text.length < STDERR_LIMIT) text += chunk.toString().slice(0, STDERR_LIMIT - text.length);
  });
  return () => text;
}

async function runGrep(
  pi: PiCodingAgentModule,
  rgPath: string,
  cwd: string,
  params: GrepParams,
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: GrepToolDetails | undefined }> {
  const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params;
  const searchPath = resolveToCwd(searchDir || '.', cwd);
  const coveredFiles = new Map<string, boolean>();
  let leftOut = false;
  const isCovered = (filePath: string): boolean => {
    let value = coveredFiles.get(filePath);
    if (value === undefined) {
      value = covered(filePath);
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
  const contextValue = context && context > 0 ? context : 0;
  const effectiveLimit = Math.max(1, limit ?? GREP_DEFAULT_LIMIT);
  const formatPath = (filePath: string): string => {
    if (isDirectory) {
      const relative = path.relative(searchPath, filePath);
      if (relative && !relative.startsWith('..')) return relative.replace(/\\/g, '/');
    }
    return path.basename(filePath);
  };

  const args = ['--json', '--line-number', '--color=never', '--hidden'];
  if (ignoreCase) args.push('--ignore-case');
  if (literal) args.push('--fixed-strings');
  if (glob) args.push('--glob', glob);
  args.push('--', pattern, searchPath);

  const matches: GrepMatch[] = [];
  let matchLimitReached = false;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const stderr = captureStderr(child.stderr);
    let killedDueToLimit = false;
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    lines.on('line', (line) => {
      if (!line.trim() || matches.length >= effectiveLimit) return;
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== 'match') return;
      // pi also counts a match whose path is not UTF-8 (`path.bytes`) and then prints nothing for it; only printable matches count here.
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (!filePath || typeof lineNumber !== 'number') return;
      if (isCovered(filePath)) {
        leftOut = true;
        return;
      }
      matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
      if (matches.length >= effectiveLimit) {
        matchLimitReached = true;
        killedDueToLimit = true;
        child.kill();
      }
    });
    child.on('error', (error) => {
      lines.close();
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
    child.on('close', (code) => {
      lines.close();
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(aborted());
      if (!killedDueToLimit && code !== 0 && code !== 1) return reject(new Error(stderr().trim() || `ripgrep exited with code ${code}`));
      resolve();
    });
  });

  if (matches.length === 0) return { content: [{ type: 'text', text: leftOut ? `No matches found\n\n[${LEFT_OUT_NOTICE}]` : 'No matches found' }], details: undefined };

  let linesTruncated = false;
  const truncate = (text: string): string => {
    const { text: truncated, wasTruncated } = pi.truncateLine(text);
    if (wasTruncated) linesTruncated = true;
    return truncated;
  };
  const fileCache = new Map<string, string[]>();
  const fileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        lines = (await readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  const outputLines: string[] = [];
  for (const match of matches) {
    const relativePath = formatPath(match.filePath);
    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = match.lineText.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '');
      outputLines.push(`${relativePath}:${match.lineNumber}: ${truncate(sanitized)}`);
      continue;
    }
    const lines = await fileLines(match.filePath);
    if (!lines.length) {
      outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }
    const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
    const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
    for (let current = start; current <= end; current++) {
      const text = truncate((lines[current - 1] ?? '').replace(/\r/g, ''));
      outputLines.push(current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`);
    }
  }

  const truncation = pi.truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
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

/** pi's `grep` (name, schema, description, renderers) with an `execute` that runs the bundled rg exactly as pi runs its own. */
export function createGrepTool(pi: PiCodingAgentModule, cwd: string, resolveRgPath: ResolveRgPath, readRuleFilter: ReadRuleFilter): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createGrepToolDefinition(cwd);
  return {
    ...metadata,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (signal?.aborted) throw aborted();
      return runGrep(pi, await resolveRgPath(), ctx?.cwd || cwd, params as GrepParams, signal, await readRuleFilter());
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

async function insideGitRepo(searchPath: string): Promise<boolean> {
  for (let current = searchPath; ; ) {
    if (await exists(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

/**
 * fd's `--glob` matching as pi's `find` drives it: smart case, dotfiles included, a pattern without
 * `/` matched against the name, one with `/` against the full path with `**\/` in front unless it is
 * anchored or already starts with it.
 */
export function fdGlobMatcher(pattern: string): (absolutePath: string) => boolean {
  // fd's glob dialect has no leading-`!` negation and no extglobs.
  const options = { dot: true, nocase: pattern === pattern.toLowerCase(), windows: false, nonegate: true, noextglob: true };
  if (!pattern.includes('/')) {
    const matches = picomatch(pattern, options);
    return (absolutePath) => matches(path.basename(absolutePath));
  }
  const anchored = pattern.startsWith('/') || pattern.startsWith('**/') || pattern === '**' || path.isAbsolute(pattern);
  const matches = picomatch(anchored ? pattern : `**/${pattern}`, options);
  return (absolutePath) => matches(toPosix(absolutePath));
}

/**
 * Every file under `searchPath` that `pattern` matches, and every directory holding a listed file,
 * up to `limit`, directories with a trailing separator. ripgrep lists the files; the pattern is
 * applied here because an rg `--glob` include overrides `.gitignore`, which fd's never does. Unlike
 * fd, it reports no empty directory, no directory whose files are all ignored, and no symlink.
 */
async function listMatchingPaths(
  rgPath: string,
  pattern: string,
  searchPath: string,
  options: { ignore: string[]; limit: number },
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
  onLeftOut: () => void,
): Promise<string[]> {
  if (!(await stat(searchPath)).isDirectory()) throw new Error(`Search path is not a directory: ${searchPath}`);
  if (options.limit <= 0) return [];
  const args = ['--files', '--hidden', '--null', '--color=never'];
  // fd applies .gitignore outside a repository only with this flag, and pi passes it there.
  if (!(await insideGitRepo(searchPath))) args.push('--no-require-git');
  for (const glob of options.ignore) args.push('--glob', `!${glob}`);
  // rg matches globs against the path below its working directory, so pi's node_modules and .git
  // excludes must not see the ancestors of a search root that sits inside one.
  args.push('--', '.');
  const matches = fdGlobMatcher(pattern);
  const seenDirectories = new Set<string>();
  const results: string[] = [];

  return new Promise<string[]>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const child = spawn(rgPath, args, { cwd: searchPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = captureStderr(child.stderr);
    let listedAny = false;
    let pending = '';
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const add = (entry: string): void => {
      if (results.length >= options.limit) return;
      results.push(entry);
      if (results.length >= options.limit) child.kill();
    };
    const take = (entry: string): void => {
      listedAny = true;
      if (results.length >= options.limit) return;
      const file = path.resolve(searchPath, entry);
      const relative = path.relative(searchPath, path.dirname(file));
      if (relative && !relative.startsWith('..')) {
        let directory = searchPath;
        for (const segment of relative.split(path.sep)) {
          directory = path.join(directory, segment);
          if (seenDirectories.has(directory)) continue;
          seenDirectories.add(directory);
          if (matches(directory)) add(directory + path.sep);
        }
      }
      if (!matches(file)) return;
      if (covered(file)) onLeftOut();
      else add(file);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const entries = (pending + chunk).split('\0');
      pending = entries.pop() ?? '';
      for (const entry of entries) if (entry) take(entry);
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(aborted());
      // rg exits 2 on any error, such as one unreadable directory; with files listed, that is a partial walk.
      if (code !== 0 && code !== 1 && !listedAny) return reject(new Error(stderr().trim() || `ripgrep exited with code ${code}`));
      resolve(results);
    });
  });
}

function rgFindOperations(
  resolveRgPath: ResolveRgPath,
  signal: AbortSignal | undefined,
  covered: (filePath: string) => boolean,
  onLeftOut: () => void,
): FindOperations {
  return {
    exists,
    glob: async (pattern, searchPath, options) => listMatchingPaths(await resolveRgPath(), pattern, searchPath, options, signal, covered, onLeftOut),
  };
}

/** pi's hook branch drops the retry hint its fd branch gives on the limit notice; this puts it back. */
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
export function createFindTool(pi: PiCodingAgentModule, cwd: string, resolveRgPath: ResolveRgPath, readRuleFilter: ReadRuleFilter): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createFindToolDefinition(cwd);
  return {
    ...metadata,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      let leftOut = false;
      const operations = rgFindOperations(resolveRgPath, signal, await readRuleFilter(), () => { leftOut = true; });
      const find: AnyToolDefinition = pi.createFindToolDefinition(cwd, { operations });
      const result = withLimitHint(await find.execute(toolCallId, params, signal, onUpdate, ctx));
      if (!leftOut) return result;
      return { ...result, content: [...result.content, { type: 'text', text: `\n\n[${LEFT_OUT_NOTICE}]` }] };
    },
  };
}
