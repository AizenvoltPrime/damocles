import { existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FindOperations, FindToolDetails, GrepToolDetails, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from './any-tool-definition';
import type { PiCodingAgentModule } from '../pi-loader';
import { ALL_IGNORE_FILES, batchLineBudget, decodeRgText, runRg, runWalkedRg, walkHost, type RgLineEvent, type RgRunEnd, type WalkStream } from '../../search-walk';

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

// Of the files rg could not read, the ones Grep's notice names, each name cut to MAX_UNREADABLE_NAME_CHARS.
const MAX_UNREADABLE_NAMED = 5;
const MAX_UNREADABLE_NAME_CHARS = 200;

// rg's stderr line for a file it could not read: `rg: <path>: <the OS's message> (os error <n>)`.
const UNREADABLE_LINE = /^rg: (.+): [^:]*\(os error \d+\)$/;

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

  const flags = ['--json', '--line-number', '--color=never', '--hidden'];
  if (ignoreCase) flags.push('--ignore-case');
  if (literal) flags.push('--fixed-strings');
  if (contextValue > 0) flags.push('--context', String(contextValue));
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

  // rg exits 2 after a search that could not read some files, naming each on stderr: Grep keeps the matches and names those files
  const unreadable: string[] = [];
  let unreadableMore = false;
  const runEnded = ({ code, stderr, summary }: RgRunEnd): Error | undefined => {
    if (code === 0 || code === 1) return undefined;
    // no summary: rg searched nothing (a regex it refused), which fails Grep as it fails pi's grep
    if (code !== 2 || !summary) return new Error(stderr || `ripgrep exited with code ${code}`);
    for (const line of stderr.split(/\r?\n/)) {
      const name = UNREADABLE_LINE.exec(line)?.[1];
      if (name === undefined) continue;
      if (isCovered(name)) leftOut = true;
      else if (unreadable.length < MAX_UNREADABLE_NAMED) unreadable.push(formatPath(name).slice(0, MAX_UNREADABLE_NAME_CHARS));
      else unreadableMore = true;
    }
    return undefined;
  };

  const engine = { rgPath, signal, onEvent, done: () => done, runEnded };
  if (!isDirectory) {
    // --no-config, as in pi's grep: a RIPGREP_CONFIG_PATH file must not change what the tool's options mean; a file named on
    // rg's command line is searched whatever --glob says
    await runRg({ ...engine, args: ['--no-config', ...flags, ...(globLine ? ['--glob', globLine] : []), '--', pattern, searchPath] });
  } else {
    let walk: WalkStream | undefined;
    await runWalkedRg({
      ...engine,
      cwd: searchPath,
      flags,
      pattern,
      batches: async function* (listing) {
        walk = walkHost().walk({ root: searchPath, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: globLine ? [globLine] : [], allowedHosts: await walkHosts(allowedHosts), lineBudget: Math.max(1, batchLineBudget(rgPath, flags, pattern)) }, listing);
        yield* walk;
      },
      // once the hold would end the search or outgrow the output cap
      mustRelease: (held) => matchCount + held.matches > effectiveLimit || held.bytes > pi.DEFAULT_MAX_BYTES,
    });
    if (!done && walk !== undefined && walk.errors.length > 0) throw new Error(walk.errors.join('\n'));
  }
  const unreadableNotice = unreadable.length === 0 ? undefined : `ripgrep could not read ${unreadable.join(', ')}${unreadableMore ? ' and other files' : ''}`;

  if (matchCount === 0) {
    const notices = [...(unreadableNotice ? [unreadableNotice] : []), ...(leftOut ? [LEFT_OUT_NOTICE] : [])];
    return { content: [{ type: 'text', text: notices.length > 0 ? `No matches found\n\n[${notices.join('. ')}]` : 'No matches found' }], details: undefined };
  }

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
  if (unreadableNotice) notices.push(unreadableNotice);
  if (leftOut) notices.push(LEFT_OUT_NOTICE);
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
  return { content: [{ type: 'text', text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

// networkReach places a .git file's pointer only on win32, so elsewhere the chat's hosts, a realpath of its folders, are not read.
async function walkHosts(allowedHosts: () => Promise<ReadonlySet<string>>): Promise<string[]> {
  return process.platform === 'win32' ? [...(await allowedHosts())] : [];
}

/**
 * pi's `grep` (name, schema, description, renderers) with an `execute` that runs the bundled rg as pi runs its own: on a file
 * named by `path` itself, else on the files the walk process lists (`walkHost`). allowedNetworkHosts: the chat's hosts, onto which a
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
  // fd applies .gitignore outside a repository only with --no-require-git, and pi passes it there ('insideRepo'). pi's
  // node_modules and .git excludes match the path below the search root, so a root inside either still lists.
  const walk = walkHost().walk({ root: searchPath, requireGit: 'insideRepo', ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: options.ignore.map((glob) => `!${glob}`), allowedHosts: await walkHosts(allowedHosts) }, signal);
  const matches = fdGlobMatcher(pattern);
  const seenDirectories = new Set<string>();
  const results: string[] = [];
  let listedAny = false;
  const add = (entry: string): void => {
    if (results.length < options.limit) results.push(entry);
  };
  listing: for await (const batch of walk) {
    listedAny = true;
    for (const listed of batch) {
      const entry = path.sep === '/' ? listed : listed.replaceAll('/', path.sep);
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
      if (results.length >= options.limit) break listing;
    }
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
