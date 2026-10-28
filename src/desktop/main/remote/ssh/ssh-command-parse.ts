// "+ New host": `user@host[:port]`, `ssh://user@host:port` or a pasted ssh command, parsed against an allowlist and read as
// ssh reads it. Anything that could run a command, read another config or weaken host key checking is refused by name;
// options in the user's own ~/.ssh/config are ssh's to read and never parsed here.
import * as net from 'node:net';
import * as path from 'node:path';
import type { HostParseRefusal } from '../../../preload/overlay-channels';

// The options a saved address keeps; `-l`/`User` and `-p`/`Port` are its user and port.
export const ALLOWED_SSH_OPTION_NAMES = ['IdentityFile', 'IdentitiesOnly', 'ProxyJump', 'AddressFamily', 'Compression', 'PreferredAuthentications'] as const;
export type AllowedSshOptionName = (typeof ALLOWED_SSH_OPTION_NAMES)[number];

// The options of FIXED_SSH_OPTIONS (ssh-args.ts) a pasted command may carry; Damocles' values come first and win.
const DAMOCLES_SET_OPTION_NAMES = ['ServerAliveInterval', 'ServerAliveCountMax', 'ConnectTimeout'] as const;

export interface AllowedSshOption {
  readonly name: AllowedSshOptionName;
  readonly value: string;
}

export type SshDestination =
  | { readonly kind: 'alias'; readonly alias: string }
  | { readonly kind: 'address'; readonly host: string; readonly user?: string; readonly port?: number; readonly options: readonly AllowedSshOption[] };

export type AddressDestination = Extract<SshDestination, { kind: 'address' }>;

export type SshParseResult =
  | { readonly ok: true; readonly destination: AddressDestination }
  | { readonly ok: false; readonly refused: string; readonly reason: HostParseRefusal };

// bounds that keep the parse cheap; no real command or option value comes near them
const MAX_INPUT_CHARS = 4096;
const MAX_VALUE_CHARS = 1024;
export const UNSAFE: RegExp = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// 253: the longest DNS name
const HOST_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;
// at most 256 characters; `@` splits at the last one, so only a leading one is refused
const USER = /^[^\s:@/-][^\s:/]{0,255}$/;
// what OpenSSH 10 refuses in a user name; older clients pass it to `%r` in the user's ProxyCommand or Match exec
const USER_REFUSED = /['"`$\\;&<>|(){}]/;
const AUTH_METHODS = new Set(['gssapi-with-mic', 'hostbased', 'publickey', 'keyboard-interactive', 'password']);
// a word processor's dashes and quotes, which a pasted command can carry in place of `-` and straight quotes
const TYPOGRAPHIC_DASH = /^[\u2013\u2014\u2212]/;
const TYPOGRAPHIC_QUOTE = /^[\u2018\u2019\u201C\u201D]|[\u2018\u2019\u201C\u201D]$/;

const isPort = (text: string): boolean => /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535;

/** A host ssh takes after `--`: a name, an IPv4 or an IPv6 address; nothing starting with `-`. */
export function isSafeHost(host: string): boolean {
  return HOST_NAME.test(host) || net.isIPv6(host);
}

/** A user ssh takes as `-l`'s value: nothing starting with `-` and none of the characters ssh refuses. */
export function isSafeUser(user: string): boolean {
  return USER.test(user) && !USER_REFUSED.test(user) && !UNSAFE.test(user);
}

export type JumpHost = { readonly user?: string; readonly host: string; readonly port?: number };

interface SplitHop {
  readonly user?: string;
  readonly host: string;
  readonly port?: string;
}

// misc.c urldecode: `+` is a space and %XX a byte; a malformed escape or %00 refuses the whole value.
function urlDecode(text: string): string | undefined {
  if (!/^(?:[^%]|%[0-9A-Fa-f]{2})*$/.test(text) || /%00/.test(text)) return undefined;
  const parts = text.replace(/\+/g, ' ').split(/(%[0-9A-Fa-f]{2})/);
  return Buffer.concat(parts.map((part) => (part.startsWith('%') ? Buffer.from([parseInt(part.slice(1), 16)]) : Buffer.from(part, 'utf8')))).toString('utf8');
}

// [user@]host[:port] split at the last @ (misc.c parse_user_host_port), [user@][v6]:port, or ssh://[user[;params]@]host[:port][/]
// split at the first @ with the user percent-decoded (parse_uri). A jump hop splits an unbracketed host at its first `:` as
// ssh's hpdelim does; the destination takes a bare IPv6 address whole. Host, user and port are the caller's to check.
function splitHop(text: string, jump: boolean): SplitHop | undefined {
  const uri = text.startsWith('ssh://');
  const url = uri ? text.slice('ssh://'.length).replace(/\/$/, '') : text;
  const at = uri ? url.indexOf('@') : url.lastIndexOf('@');
  const user = at < 0 ? undefined : uri ? urlDecode(url.slice(0, at).split(';')[0]!) : url.slice(0, at);
  if (at >= 0 && !user) return undefined;
  const rest = at >= 0 ? url.slice(at + 1) : url;
  let host = rest;
  let port: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(rest);
  const colons = (rest.match(/:/g) ?? []).length;
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2];
  } else if (colons === 1 || (jump && colons > 1)) {
    const colon = rest.indexOf(':');
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
  }
  if (host === '' || host.includes('/')) return undefined;
  return { host, ...(user !== undefined ? { user } : {}), ...(port !== undefined ? { port } : {}) };
}

type HopPart = 'destination' | 'host' | 'user' | 'port';

function checkHop(text: string, jump: boolean): { readonly ok: true; readonly hop: JumpHost } | { readonly ok: false; readonly part: HopPart } {
  const split = splitHop(text, jump);
  if (!split) return { ok: false, part: 'destination' };
  if (!isSafeHost(split.host)) return { ok: false, part: 'host' };
  if (split.user !== undefined && !isSafeUser(split.user)) return { ok: false, part: 'user' };
  if (split.port !== undefined && !isPort(split.port)) return { ok: false, part: 'port' };
  return { ok: true, hop: { host: split.host, ...(split.user !== undefined ? { user: split.user } : {}), ...(split.port !== undefined ? { port: Number(split.port) } : {}) } };
}

/** ProxyJump's comma-separated hops as ssh splits them; undefined when one is malformed. */
export function parseJumpList(value: string): JumpHost[] | undefined {
  const hops: JumpHost[] = [];
  for (const text of value.split(',')) {
    const split = splitHop(text, true);
    if (!split || (split.port !== undefined && !isPort(split.port))) return undefined;
    hops.push({ host: split.host, ...(split.user !== undefined ? { user: split.user } : {}), ...(split.port !== undefined ? { port: Number(split.port) } : {}) });
  }
  return hops;
}

type IdentityFileProblem = 'value' | 'relativePath';

// the tokens ssh_config(5) lists for IdentityFile; ssh ends its run on any other `%`
const IDENTITY_TOKEN = /%[%CdhijkLlnpru]/g;

// An identity file ssh resolves the same from any working folder: absolute on this computer, `~`, `none`, or starting with
// `%d` (the home folder) or a `${}` variable. Off Windows a backslash is refused, since OpenSSH before and after 8.7 read it
// differently in `-o`.
function identityFileProblem(value: string, platform: NodeJS.Platform): IdentityFileProblem | undefined {
  if (value.startsWith('-') || value.replace(IDENTITY_TOKEN, '').includes('%') || (platform !== 'win32' && value.includes('\\'))) return 'value';
  const absolute = platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
  return absolute || value === 'none' || value.startsWith('~') || value.startsWith('%d') || value.startsWith('${') ? undefined : 'relativePath';
}

/** Whether a saved option is one this parser would store, value included. */
export function isAllowedSshOption(option: { readonly name: string; readonly value: string }, platform: NodeJS.Platform = process.platform): option is AllowedSshOption {
  if (!(ALLOWED_SSH_OPTION_NAMES as readonly string[]).includes(option.name)) return false;
  const { value } = option;
  if (value === '' || value.length > MAX_VALUE_CHARS || UNSAFE.test(value) || value.includes('"')) return false;
  switch (option.name as AllowedSshOptionName) {
    case 'IdentityFile': return identityFileProblem(value, platform) === undefined;
    case 'IdentitiesOnly':
    case 'Compression': return value === 'yes' || value === 'no';
    case 'ProxyJump': return value === 'none' || value.split(',').every((hop) => checkHop(hop, true).ok);
    case 'AddressFamily': return value === 'any' || value === 'inet' || value === 'inet6';
    case 'PreferredAuthentications': return value.split(',').every((method) => AUTH_METHODS.has(method));
  }
}

// The stored form of a value ssh reads case-insensitively: `true`/`false` as yes/no, lower case.
function normalizedValue(name: AllowedSshOptionName, value: string): string {
  if (name === 'IdentitiesOnly') return ({ true: 'yes', false: 'no' } as Record<string, string>)[value.toLowerCase()] ?? value.toLowerCase();
  return name === 'Compression' || name === 'AddressFamily' ? value.toLowerCase() : value;
}

/**
 * The words of a pasted command as a POSIX shell splits them, with one difference: a backslash escapes only whitespace or a
 * quote, outside quotes and inside double quotes, so a Windows path keeps its backslashes. A word starting with `#` begins a
 * comment. Nothing is expanded: `$HOME`, `%USERPROFILE%` and `*` stay as written. Undefined for an unclosed quote.
 */
export function splitShellWords(input: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    const next = input[index + 1] ?? '';
    const escapes = char === '\\' && /[\s"']/.test(next);
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (escapes) word += input[++index];
      else word += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    if (!inWord && char === '#') break;
    inWord = true;
    if (char === "'" || char === '"') quote = char;
    else if (escapes) word += input[++index];
    else word += char;
  }
  if (quote !== undefined) return undefined;
  if (inWord) words.push(word);
  return words;
}

/**
 * One `-o` line's value words as OpenSSH 8.7 and later split a config line (misc.c argv_split): single and double quotes,
 * `\\`, `\'`, `\"` and, outside quotes, `\ ` escapes, any other backslash kept, and a word starting with `#` ending the line.
 */
function configWords(text: string): string[] | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === ' ' || text[index] === '\t') {
      index++;
      continue;
    }
    if (text[index] === '#') break;
    let word = '';
    let quote: string | undefined;
    for (; index < text.length; index++) {
      const char = text[index]!;
      const next = text[index + 1];
      if (char === '\\' && (next === "'" || next === '"' || next === '\\' || (quote === undefined && next === ' '))) word += text[++index];
      else if (quote === undefined && (char === ' ' || char === '\t')) break;
      else if (quote === undefined && (char === '"' || char === "'")) quote = char;
      else if (quote !== undefined && char === quote) quote = undefined;
      else word += char;
    }
    if (quote !== undefined) return undefined;
    words.push(word);
  }
  return words;
}

// readconf.c: the keyword ends at whitespace, a quote or `=`, and one `=` with whitespace around it may follow.
function splitOption(text: string): { readonly key: string; readonly rest: string } {
  const match = /^\s*([^\s"'=]*)\s*(?:=\s*)?([\s\S]*?)\s*$/.exec(text)!;
  return { key: match[1]!, rest: match[2]! };
}

const KEYWORDS = new Map<string, string>([...ALLOWED_SSH_OPTION_NAMES, ...DAMOCLES_SET_OPTION_NAMES, 'User', 'Port'].map((name) => [name.toLowerCase(), name]));

// How ssh spells the refused options a pasted command commonly carries; any other keeps the user's spelling.
const REFUSED_SPELLINGS = new Map<string, string>([
  'LocalCommand', 'PermitLocalCommand', 'PKCS11Provider', 'SecurityKeyProvider', 'KnownHostsCommand', 'ProxyCommand', 'RemoteCommand',
  'UserKnownHostsFile', 'StrictHostKeyChecking',
].map((name) => [name.toLowerCase(), name]));

function refusedOptionName(key: string, value: string): string {
  const name = REFUSED_SPELLINGS.get(key.toLowerCase()) ?? key;
  if (name === 'StrictHostKeyChecking') return `StrictHostKeyChecking=${value}`;
  if (key.toLowerCase() === 'match' && /^exec\b/i.test(value)) return 'Match exec';
  return name;
}

// ssh's program name, bare or with a path, any case, with or without .exe
const SSH_PROGRAM = /^(?:.*[/\\])?ssh(?:\.exe)?$/i;
// a shell prompt or PowerShell's call operator pasted before the program
const PROMPTS = new Set(['$', '>', '%', '&']);
// getopt's flags taking no value that map onto an allowlisted option
const NO_VALUE_FLAGS: Readonly<Record<string, { readonly name: AllowedSshOptionName; readonly value: string }>> = {
  '4': { name: 'AddressFamily', value: 'inet' },
  '6': { name: 'AddressFamily', value: 'inet6' },
  C: { name: 'Compression', value: 'yes' },
};
const VALUE_FLAGS = new Set(['l', 'p', 'i', 'J', 'o']);

type Refusal = { readonly ok: false; readonly refused: string; readonly reason: HostParseRefusal };
const refuse = (refused: string, reason: HostParseRefusal): Refusal => ({ ok: false, refused, reason });

/**
 * Parses "+ New host" input. User and port are one setting each whichever route gives them (`user@`, `-l`, `-o User`; `:port`,
 * `-p`, `-o Port`), as is every option but IdentityFile; a second route with another value is refused, and so is a second
 * `-J` or `-J` beside `-o ProxyJump`, as ssh refuses them. Every refusal names what the user would look for.
 */
export function parseSshCommand(input: string, platform: NodeJS.Platform = process.platform): SshParseResult {
  const trimmed = input.trim();
  if (trimmed.length > MAX_INPUT_CHARS || /[\r\n\0]/.test(trimmed)) return refuse('input', 'input');
  const words = splitShellWords(trimmed);
  if (!words) return refuse('input', 'quotes');
  if (PROMPTS.has(words[0] ?? '') && SSH_PROGRAM.test(words[1] ?? '')) words.shift();
  if (SSH_PROGRAM.test(words[0] ?? '')) words.shift();
  for (const word of words) {
    const typographic = TYPOGRAPHIC_DASH.exec(word) ?? TYPOGRAPHIC_QUOTE.exec(word);
    if (typographic) return refuse(typographic[0], 'typography');
  }

  const options: AllowedSshOption[] = [];
  const settings = new Map<string, { readonly value: string; readonly route: string }>();
  // the first route to give a setting keeps it; another value, or a second -J, is a conflict
  const set = (setting: string, value: string, route: string): Refusal | undefined => {
    const held = settings.get(setting);
    if (held) return held.value !== value || (setting === 'ProxyJump' && (route === '-J' || held.route === '-J')) ? refuse(route, 'conflict') : undefined;
    settings.set(setting, { value, route });
    if (setting !== 'User' && setting !== 'Port') options.push({ name: setting as AllowedSshOptionName, value });
    return undefined;
  };
  const take = (name: string, value: string, route: string): Refusal | undefined => {
    if (value === '') return refuse(route, 'missing');
    if (value.length > MAX_VALUE_CHARS || UNSAFE.test(value)) return refuse(route, 'value');
    if (name === 'User') return isSafeUser(value) ? set('User', value, route) : refuse(route, 'value');
    if (name === 'Port') return isPort(value) ? set('Port', String(Number(value)), route) : refuse(route, 'value');
    const option = { name: name as AllowedSshOptionName, value: normalizedValue(name as AllowedSshOptionName, value) };
    if (name === 'IdentityFile') {
      const problem = identityFileProblem(value, platform);
      if (problem) return refuse(route, problem);
    }
    if (!isAllowedSshOption(option, platform)) return refuse(route, 'value');
    if (name !== 'IdentityFile') return set(name, option.value, route);
    options.push(option);
    return undefined;
  };
  const takeOptionLine = (line: string): Refusal | undefined => {
    const { key, rest } = splitOption(line);
    if (key === '') return refuse('-o', 'missing');
    const name = KEYWORDS.get(key.toLowerCase());
    if (!name) return refuse(refusedOptionName(key, rest), 'option');
    if ((DAMOCLES_SET_OPTION_NAMES as readonly string[]).includes(name)) return refuse(name, 'fixed');
    const values = configWords(rest);
    if (!values) return refuse(name, 'quotes');
    if (values.length > 1) return refuse(name, 'value');
    return take(name, values[0] ?? '', name);
  };

  let destination: string | undefined;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === '--') {
      const rest = words.slice(index + 1);
      if (destination === undefined && rest.length === 0) return refuse('destination', 'destination');
      if (destination !== undefined || rest.length > 1) return refuse('command', 'command');
      destination = rest[0];
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      if (destination !== undefined) return refuse('command', 'command');
      destination = word;
      continue;
    }
    if (word.startsWith('--')) return refuse(word, 'option');
    // getopt: flags without a value may be bundled, and a flag's value is the rest of the word or the next word
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      const mapped = NO_VALUE_FLAGS[flag];
      if (mapped) {
        const refusal = set(mapped.name, mapped.value, `-${flag}`);
        if (refusal) return refusal;
        continue;
      }
      if (!VALUE_FLAGS.has(flag)) return refuse(`-${flag}`, 'option');
      let value = word.slice(at + 1);
      if (value === '') {
        if (index + 1 >= words.length) return refuse(`-${flag}`, 'missing');
        value = words[++index]!;
      }
      const refusal = flag === 'o'
        ? takeOptionLine(value)
        : take({ l: 'User', p: 'Port', i: 'IdentityFile', J: 'ProxyJump' }[flag as 'l' | 'p' | 'i' | 'J'], value, `-${flag}`);
      if (refusal) return refusal;
      break;
    }
  }
  if (destination === undefined) return refuse('destination', 'destination');
  const checked = checkHop(destination, false);
  if (!checked.ok) return refuse(checked.part, 'destination');
  const { hop } = checked;
  for (const [setting, value] of [['User', hop.user], ['Port', hop.port === undefined ? undefined : String(hop.port)]] as const) {
    const held = value === undefined ? undefined : settings.get(setting);
    // the flag or option that disagrees with the destination is named
    if (held && held.value !== value) return refuse(held.route, 'conflict');
    if (value !== undefined && !held) settings.set(setting, { value, route: 'destination' });
  }
  const user = settings.get('User')?.value;
  const port = settings.get('Port')?.value;
  return { ok: true, destination: { kind: 'address', host: hop.host, ...(user !== undefined ? { user } : {}), ...(port !== undefined ? { port: Number(port) } : {}), options } };
}

export type SavedAddressCheck =
  | { readonly ok: true; readonly destination: AddressDestination; readonly dropped: readonly string[] }
  // setting: the part of the saved address the rules now refuse, an option's name, 'User', or 'host'
  | { readonly ok: false; readonly setting: string };

/**
 * A saved address as ssh may be given it now. A User or Port option an older parse kept is folded into the user and port when
 * it agrees with them; an option Damocles sets itself is dropped, since its value never took effect; anything else the rules
 * refuse fails the whole address, since leaving it out would change who or where ssh connects.
 */
export function checkSavedAddress(saved: { readonly host: string; readonly user?: string; readonly port?: number; readonly options: readonly { readonly name: string; readonly value: string }[] }, platform: NodeJS.Platform = process.platform): SavedAddressCheck {
  if (!isSafeHost(saved.host)) return { ok: false, setting: 'host' };
  let { user, port } = saved;
  const options: AllowedSshOption[] = [];
  const dropped: string[] = [];
  for (const option of saved.options) {
    if ((DAMOCLES_SET_OPTION_NAMES as readonly string[]).includes(option.name)) {
      dropped.push(option.name);
    } else if (option.name === 'User') {
      if (user !== undefined && user !== option.value) return { ok: false, setting: 'User' };
      user = option.value;
    } else if (option.name === 'Port') {
      if (!isPort(option.value) || (port !== undefined && port !== Number(option.value))) return { ok: false, setting: 'Port' };
      port = Number(option.value);
    } else if (isAllowedSshOption(option, platform)) {
      options.push(option);
    } else {
      return { ok: false, setting: option.name.slice(0, 64) };
    }
  }
  if (user !== undefined && !isSafeUser(user)) return { ok: false, setting: 'User' };
  return { ok: true, destination: { kind: 'address', host: saved.host, ...(user !== undefined ? { user } : {}), ...(port !== undefined ? { port } : {}), options }, dropped };
}
