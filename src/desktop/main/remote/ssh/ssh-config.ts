// The Host aliases the Connect dialog lists, read as OpenSSH's readconf.c reads its configuration: the user's file (or the one
// -F names) and the system file, following Include. Nothing here writes under ~/.ssh. resolveSshHops asks `ssh -G` for every
// hop of a connect.
import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSshConfigQueryArgs, isSafeAlias } from './ssh-args';
import { parseJumpList, type JumpHost, type SshDestination } from './ssh-command-parse';

// ssh's READCONF_MAX_DEPTH
const MAX_INCLUDE_DEPTH = 16;
// a config file past this is not read
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

// The account's passwd entry (os.userInfo()), which ssh reads instead of HOME; uid -1 where the OS has none.
export interface SshAccount {
  readonly homedir: string;
  readonly username: string;
  readonly uid: number;
}

/** The passwd entry, or undefined with a log line for an account that has none, whose ssh finds no ~/.ssh either. */
export function passwdAccount(log: (line: string) => void, userInfo: () => SshAccount = () => os.userInfo()): SshAccount | undefined {
  try {
    return userInfo();
  } catch (err) {
    log(`this account has no passwd entry, so ssh reads no ~/.ssh: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export interface SshConfigSource {
  // <passwd home>/.ssh/config, or the file -F names
  readonly userConfig: string;
  // /etc/ssh/ssh_config or %ProgramData%\ssh\ssh_config; absent under -F, since ssh then reads no system file
  readonly systemConfig?: string;
  // %d, %u and %i in an Include
  readonly account: SshAccount;
  // the path flavour every file name is built and split with
  readonly platform: NodeJS.Platform;
  // ssh's environment: ${NAME} in an Include, and HOME, which glob(3) prefers to the passwd home for `~`
  readonly env: Readonly<Record<string, string | undefined>>;
}

const flavourOf = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

/** The files ssh reads by default on this computer: the OS OpenSSH's system file, whichever client runs. */
export function defaultSshConfigSource(account: SshAccount, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): SshConfigSource {
  const { join } = flavourOf(platform);
  const programData = env['ProgramData'] ?? env['ALLUSERSPROFILE'] ?? 'C:\\ProgramData';
  return {
    userConfig: join(account.homedir, '.ssh', 'config'),
    systemConfig: platform === 'win32' ? join(programData, 'ssh', 'ssh_config') : '/etc/ssh/ssh_config',
    account,
    platform,
    env,
  };
}

// misc.c strdelim: a word ends at whitespace or one `=`, and a `"` quotes it; undefined for a quote never closed.
function strdelim(text: string): readonly [string, string | undefined] | undefined {
  const at = text.search(/[ \t\r\n"=]/);
  if (at < 0) return [text, undefined];
  if (text[at] === '"') {
    const close = text.indexOf('"', at + 1);
    return close < 0 ? undefined : [text.slice(0, at) + text.slice(at + 1, close), text.slice(close + 1).replace(/^[ \t\r\n]*/, '')];
  }
  let rest = text.slice(at + 1).replace(/^[ \t\r\n]*/, '');
  if (text[at] !== '=' && rest.startsWith('=')) rest = rest.slice(1).replace(/^[ \t\r\n]*/, '');
  return [text.slice(0, at), rest];
}

// misc.c argv_split: space and tab separate; a quote groups from anywhere in a word; \' \" and \\ escape everywhere and `\ `
// outside quotes; a word starting with # ends the line. undefined for a quote never closed.
function splitArguments(text: string): string[] | undefined {
  const args: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === ' ' || text[index] === '\t') {
      index++;
      continue;
    }
    if (text[index] === '#') break;
    let arg = '';
    let quote: string | undefined;
    for (; index < text.length; index++) {
      const char = text[index]!;
      const next = text[index + 1];
      if (char === '\\' && (next === "'" || next === '"' || next === '\\' || (quote === undefined && next === ' '))) {
        arg += next;
        index++;
      } else if (quote === undefined && (char === ' ' || char === '\t')) break;
      else if (quote === undefined && (char === '"' || char === "'")) quote = char;
      else if (char === quote) quote = undefined;
      else arg += char;
    }
    if (quote !== undefined) return undefined;
    args.push(arg);
  }
  return args;
}

// readconf.c process_config_line_depth: the keyword, lower-cased in ASCII, and its arguments; undefined for a line ssh skips
// or refuses for a reason the listing does not need, 'invalidQuotes' for an unterminated quote.
function splitConfigLine(line: string): { readonly keyword: string; readonly args: readonly string[] } | 'invalidQuotes' | undefined {
  let word = strdelim(line.replace(/[ \t\r\n\f]+$/, ''));
  if (word?.[0] === '' && word[1] !== undefined) word = strdelim(word[1]);
  if (!word || word[0] === '' || word[0].startsWith('#') || !word[1]) return undefined;
  const args = splitArguments(word[1]);
  if (!args) return 'invalidQuotes';
  return { keyword: word[0].replace(/[A-Z]/g, (char) => char.toLowerCase()), args };
}

// names a system fragment declares for tools (systemd's `.host`), not hosts the user configured
const isSpecial = (name: string): boolean => /(^|\/)\./.test(name);

interface Reading {
  readonly source: SshConfigSource;
  readonly log: (line: string) => void;
  readonly hosts: Set<string>;
}

type Expanded = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

// readconf.c expand_match_exec_or_include_path with the tokens no host decides: ${NAME}, %d, %u, %i and %%. An unset
// variable makes ssh skip the Include; the other failures end ssh's run, and the listing skips the Include for both.
function expandInclude(arg: string, source: SshConfigSource): Expanded {
  let value = '';
  for (let index = 0; index < arg.length; index++) {
    const char = arg[index]!;
    if (char === '$' && arg[index + 1] === '{') {
      const end = arg.indexOf('}', index + 2);
      const name = end < 0 ? '' : arg.slice(index + 2, end);
      if (name === '') return { ok: false, reason: 'a malformed ${}' };
      const variable = source.env[name];
      if (variable === undefined) return { ok: false, reason: `\${${name}} is not set` };
      value += variable;
      index = end;
    } else if (char === '%') {
      const token = arg[++index];
      const replacement = token === '%' ? '%' : token === 'd' ? source.account.homedir : token === 'u' ? source.account.username : token === 'i' && source.account.uid >= 0 ? String(source.account.uid) : undefined;
      if (replacement === undefined) return { ok: false, reason: `%${token ?? ''} is not known without a host` };
      value += replacement;
    } else value += char;
  }
  return { ok: true, value };
}

const MAGIC = /[*?[]/;
const CHAR_CLASSES: Readonly<Record<string, string>> = {
  alnum: 'A-Za-z0-9', alpha: 'A-Za-z', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '!-~', lower: 'a-z',
  print: ' -~', punct: '!-/:-@\\[-`{-~', space: ' \\t\\n\\r\\f\\v', upper: 'A-Z', xdigit: '0-9A-Fa-f',
};
const classChar = (char: string): string => (/[\\\]^[-]/.test(char) ? `\\${char}` : char);

type Segment = { readonly literal: string } | { readonly pattern: RegExp; readonly dot: boolean };
type Unit = { readonly char: string; readonly quoted: boolean };

// A bracket expression from its first member to its `]`: the first member is taken as written, even `]`, and the expression
// needs a `]` after it; undefined reads the `[` as itself.
function bracketSet(units: readonly Unit[], start: number): { readonly set: string; readonly end: number } | undefined {
  const plain = (at: number, char: string): boolean => units[at]?.quoted === false && units[at]!.char === char;
  if (!units.slice(start + 1).some((unit) => !unit.quoted && unit.char === ']')) return undefined;
  let set = '';
  let at = start;
  do {
    if (at >= units.length) return undefined;
    const name = plain(at, '[') && plain(at + 1, ':') ? /^\[:([a-z]+):\]/.exec(units.slice(at).map((unit) => unit.char).join(''))?.[1] : undefined;
    if (name !== undefined && CHAR_CLASSES[name] !== undefined) {
      set += CHAR_CLASSES[name];
      at += name.length + 4;
    } else if (plain(at + 1, '-') && at + 2 < units.length && !plain(at + 2, ']')) {
      // a range written high to low matches nothing
      if (units[at]!.char <= units[at + 2]!.char) set += `${classChar(units[at]!.char)}-${classChar(units[at + 2]!.char)}`;
      at += 3;
    } else set += classChar(units[at++]!.char);
  } while (!plain(at, ']'));
  return { set, end: at };
}

// One path segment as OpenBSD's glob(3) reads it: * ? and [...] with ! ranges and classes, no braces and no **; on POSIX a
// backslash quotes the next character.
function compileSegment(text: string, escapes: boolean): Segment {
  const units: Unit[] = [];
  for (let index = 0; index < text.length; index++) {
    const quoted = escapes && text[index] === '\\' && index + 1 < text.length;
    units.push({ char: text[quoted ? ++index : index]!, quoted });
  }
  if (!units.some((unit) => !unit.quoted && MAGIC.test(unit.char))) return { literal: units.map((unit) => unit.char).join('') };
  let source = '';
  for (let index = 0; index < units.length; index++) {
    const { char, quoted } = units[index]!;
    const negated = !quoted && char === '[' && units[index + 1]?.quoted === false && units[index + 1]!.char === '!';
    const bracket = !quoted && char === '[' ? bracketSet(units, index + (negated ? 2 : 1)) : undefined;
    if (bracket) {
      source += `[${negated ? '^' : ''}${bracket.set}]`;
      index = bracket.end;
    } else if (!quoted && char === '*') source += '.*';
    else if (!quoted && char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return { pattern: new RegExp(`^${source}$`, 'u'), dot: units[0]?.char === '.' };
}

// glob(3) as ssh calls it: matches sorted in byte order, a folder it cannot read skipped (no GLOB_ERR), a name starting with `.`
// matched only by a segment starting with `.`, and a literal path returned when lstat finds it.
async function glob(pattern: string, platform: NodeJS.Platform): Promise<string[]> {
  const root = flavourOf(platform).parse(pattern).root;
  // both flavours' file APIs take `/`
  const join = (folder: string, name: string): string => (folder === root ? `${folder}${name}` : `${folder}/${name}`);
  let found = [root];
  for (const text of pattern.slice(root.length).split(platform === 'win32' ? /[\\/]/ : '/')) {
    if (text === '') continue;
    const segment = compileSegment(text, platform !== 'win32');
    const next: string[] = [];
    for (const folder of found) {
      if ('literal' in segment) {
        next.push(join(folder, segment.literal));
        continue;
      }
      const names = await fs.readdir(folder || '.').catch(() => [] as string[]);
      for (const name of names) if ((segment.dot || !name.startsWith('.')) && segment.pattern.test(name)) next.push(join(folder, name));
    }
    found = next;
  }
  const exists = await Promise.all(found.map((file) => fs.lstat(file).then(() => true, () => false)));
  return found.filter((_, index) => exists[index]).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// readconf.c's oInclude: expanded, refused with `~` in a system file, anchored in ~/.ssh for a user file and beside the system
// file for the system file, then globbed with `~` as GLOB_TILDE reads it.
async function includedFiles(arg: string, fromSystem: boolean, where: string, reading: Reading): Promise<string[]> {
  const { source, log } = reading;
  const skip = (reason: string): string[] => {
    log(`[ssh-config] ${where}: Include ${arg} skipped: ${reason}`);
    return [];
  };
  if (arg === '') return skip('an empty argument');
  const expanded = expandInclude(arg, source);
  if (!expanded.ok) return skip(expanded.reason);
  const flavour = flavourOf(source.platform);
  let pattern = expanded.value;
  if (pattern.startsWith('~') && fromSystem) return skip('`~` in a system file');
  if (!flavour.isAbsolute(pattern) && !pattern.startsWith('~')) {
    pattern = fromSystem && source.systemConfig !== undefined ? `${flavour.dirname(source.systemConfig)}/${pattern}` : `~/.ssh/${pattern}`;
  }
  if (pattern.startsWith('~')) {
    const rest = pattern.slice(1);
    if (rest !== '' && !rest.startsWith('/') && !(source.platform === 'win32' && rest.startsWith('\\'))) return skip('`~user` is not expanded');
    const home = source.env['HOME'] ?? source.account.homedir;
    // glob(3) inserts the home after reading the pattern's backslashes
    pattern = `${source.platform === 'win32' ? home : home.replace(/\\/g, '\\\\')}${rest}`;
  }
  const files = await glob(pattern, source.platform);
  if (files.length === 0) log(`[ssh-config] ${where}: Include ${arg} matched no files`);
  return files;
}

// The text of a regular file within MAX_CONFIG_BYTES and its identity; a file that is missing is skipped silently as ssh skips
// it, any other that cannot be read with a log line naming it and the reason.
async function readConfigFile(file: string, log: (line: string) => void): Promise<{ readonly text: string; readonly id: string } | undefined> {
  const failed = (reason: string): undefined => {
    log(`[ssh-config] ${file}: ${reason}`);
    return undefined;
  };
  // O_NONBLOCK: opening a FIFO waits for a writer otherwise; Windows has neither
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)).catch((err: unknown) => err as NodeJS.ErrnoException);
  if (!('stat' in handle)) return handle.code === 'ENOENT' ? undefined : failed(handle.code ?? handle.message);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return failed('not a regular file');
    if (stat.size > MAX_CONFIG_BYTES) return failed(`larger than ${MAX_CONFIG_BYTES} bytes`);
    return { text: await handle.readFile('utf8'), id: `${stat.dev}:${stat.ino}` };
  } catch (err) {
    return failed((err as NodeJS.ErrnoException).code ?? String(err));
  } finally {
    await handle.close();
  }
}

async function readConfig(file: string, fromSystem: boolean, open: readonly string[], reading: Reading): Promise<void> {
  if (open.length > MAX_INCLUDE_DEPTH) {
    reading.log(`[ssh-config] ${file}: Include nested deeper than ${MAX_INCLUDE_DEPTH}`);
    return;
  }
  const read = await readConfigFile(file, reading.log);
  if (!read) return;
  // ssh ends its run at a loop, when the depth runs out
  if (open.includes(read.id)) {
    reading.log(`[ssh-config] ${file}: Include loop`);
    return;
  }
  const lines = read.text.split('\n');
  for (const [index, line] of lines.entries()) {
    const parsed = splitConfigLine(line);
    if (parsed === 'invalidQuotes') reading.log(`[ssh-config] ${file} line ${index + 1}: invalid quotes`);
    if (typeof parsed !== 'object') continue;
    if (parsed.keyword === 'host') {
      for (const name of parsed.args) if (isSafeAlias(name) && !isSpecial(name)) reading.hosts.add(name);
    } else if (parsed.keyword === 'include') {
      // listed whatever block it stands in: ssh parses an inactive block's Include too, and which block applies depends on the host
      for (const arg of parsed.args) {
        for (const included of await includedFiles(arg, fromSystem, `${file} line ${index + 1}`, reading)) await readConfig(included, fromSystem, [...open, read.id], reading);
      }
    }
  }
}

/** Every concrete Host alias a connect can name, in the order ssh reads them; a file that cannot be read is logged and skipped. */
export async function listSshConfigHosts(source: SshConfigSource, log: (line: string) => void): Promise<string[]> {
  const reading: Reading = { source, log, hosts: new Set() };
  await readConfig(source.userConfig, false, [], reading);
  if (source.systemConfig !== undefined) await readConfig(source.systemConfig, true, [], reading);
  return [...reading.hosts];
}

// One hop of a connection as `ssh -G` resolved it: the alias or host the hop was named by, and what ssh connects to.
export interface SshHop {
  readonly alias: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  // IdentityFile values as ssh -G prints them, `~` not expanded
  readonly identityFiles: readonly string[];
  // ssh names the host in its password prompts by this instead of the alias or HostName
  readonly hostKeyAlias?: string;
  // a ProxyCommand other than none: ssh connects through a command whose own hops are not resolved
  readonly proxyCommand?: true;
}

interface HopConfig extends Omit<SshHop, 'alias'> {
  readonly proxyJump?: string;
}

// `ssh -G` prints one lower-case `key value` line per option, IdentityFile once per file; the first value of a key is in effect.
function parseSshG(stdout: string): HopConfig | undefined {
  const values = new Map<string, string>();
  const identityFiles: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    if (match[1] === 'identityfile') identityFiles.push(value);
    else if (!values.has(match[1]!)) values.set(match[1]!, value);
  }
  const hostname = values.get('hostname');
  const user = values.get('user');
  const portText = values.get('port') ?? '';
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  const proxyJump = values.get('proxyjump');
  const proxyCommand = values.get('proxycommand');
  const hostKeyAlias = values.get('hostkeyalias');
  if (!hostname || !user || port < 1 || port > 65535) return undefined;
  return {
    hostname,
    user,
    port,
    identityFiles,
    ...(proxyJump !== undefined && proxyJump.toLowerCase() !== 'none' ? { proxyJump } : {}),
    ...(hostKeyAlias !== undefined && hostKeyAlias !== '' ? { hostKeyAlias } : {}),
    ...(proxyCommand !== undefined && proxyCommand.toLowerCase() !== 'none' ? { proxyCommand: true as const } : {}),
  };
}

// `ssh -G` queries one resolution makes at most, the target's included
const MAX_HOPS = 8;
const MAX_STDERR_CHARS = 500;

export class SshHopsError extends Error {
  override readonly name = 'SshHopsError';
}

export interface SshHopsInput {
  readonly ssh: string;
  readonly destination: SshDestination;
  readonly configFile?: string;
  // the attempt's: an abort kills the running `ssh -G` and fails the resolution
  readonly signal: AbortSignal;
  // runs ssh with these arguments on main's launcher
  readonly run: (ssh: string, args: readonly string[], signal: AbortSignal) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;
}

// ssh names a jump without a user or port on its command line as written, so it is an alias; else -l and -p carry them
const jumpDestination = (jump: JumpHost): SshDestination =>
  jump.user === undefined && jump.port === undefined
    ? { kind: 'alias', alias: jump.host }
    : { kind: 'address', host: jump.host, ...(jump.user !== undefined ? { user: jump.user } : {}), ...(jump.port !== undefined ? { port: jump.port } : {}), options: [] };

/**
 * Every hop ssh authenticates to for the destination, the target last. ssh reaches the first ProxyJump host with that
 * host's own configuration, its own ProxyJump included, and each later one with -J naming the jumps before it. A
 * ProxyCommand hop is not followed. A loop, more than MAX_HOPS queries or a failed query rejects the whole resolution.
 */
export async function resolveSshHops(input: SshHopsInput): Promise<SshHop[]> {
  const hops: SshHop[] = [];
  let queried = 0;
  const resolve = async (destination: SshDestination, followJumps: boolean, path: readonly string[]): Promise<void> => {
    const name = destination.kind === 'alias' ? destination.alias : destination.host;
    const args = buildSshConfigQueryArgs(destination, input.configFile);
    // the same query again below itself reads the same ProxyJump, without end
    const query = JSON.stringify(args);
    if (path.includes(query)) throw new SshHopsError(`ProxyJump loop at ${name}`);
    if (++queried > MAX_HOPS) throw new SshHopsError(`more than ${MAX_HOPS} ssh hops at ${name}`);
    const { code, stdout, stderr } = await input.run(input.ssh, args, input.signal);
    const config = code === 0 ? parseSshG(stdout) : undefined;
    if (!config) throw new SshHopsError(`ssh -G ${name} failed (exit ${String(code)}): ${stderr.trim().slice(0, MAX_STDERR_CHARS)}`);
    const jumps = followJumps && config.proxyJump !== undefined ? parseJumpList(config.proxyJump) : [];
    if (!jumps) throw new SshHopsError(`the ProxyJump ${String(config.proxyJump)} of ${name} did not parse`);
    for (const [index, jump] of jumps.entries()) await resolve(jumpDestination(jump), index === 0, [...path, query]);
    const { proxyJump: _proxyJump, ...hop } = config;
    hops.push({ alias: name, ...hop });
  };
  await resolve(input.destination, true, []);
  return hops;
}
