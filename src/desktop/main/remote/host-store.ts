import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import type { ShellPlatform } from '../../preload/shell-channels';
import { HOST_SWITCH_KEYS, MAX_HOST_NAME_LENGTH, type CachedPlatform, type HostSettingChange, type NameCheck } from '../../preload/overlay-channels';
import { HOST_ID } from '../../daemon/control-messages';
import { authorityKeyOfProject } from '../../../shared/project-location';
import { isHostTone, type HostTone } from '../../../shared/host-tones';
import { PERMISSION_MODES, type PermissionMode } from '../../../shared/types/settings';

const SCHEMA_VERSION = 1;
export const HOST_STORE_FILE = 'remote-hosts.json';
// Folders a host's card offers first in its folder browser.
export const MAX_RECENT_FOLDERS = 10;
// The group key of this computer's projects in groupOrder.
export const LOCAL_GROUP = 'local';

// A project on another authority: its folder as the target names it, the folder key the target computed for it, and the
// target's OS, whose path flavor main joins its paths in (pathFor)
export interface RemoteProjectRecord {
  readonly path: string;
  readonly folderKey: string;
  readonly os: ShellPlatform;
}

// How ssh reaches a saved host: a Host alias of ~/.ssh/config, or "+ New host"'s destination and its allowlisted options.
export type SshHostDestination =
  | { readonly kind: 'alias'; readonly alias: string }
  | { readonly kind: 'address'; readonly host: string; readonly user?: string; readonly port?: number; readonly options: readonly { readonly name: string; readonly value: string }[] };

// A host's own settings; an absent switch is off.
export interface SshHostSettings {
  readonly installFolder?: string;
  // new chats' mode; absent: the target's own damocles.permissionMode
  readonly defaultPermissionMode?: PermissionMode;
  // Allow YOLO
  readonly allowBypass?: boolean;
  // POSIX targets only
  readonly forwardAgent?: boolean;
  readonly rememberPassword?: boolean;
  readonly browserLocalNetwork?: boolean;
  readonly openLinksWithoutAsking?: boolean;
}

// A saved SSH host; its projects and trusted folders live under its authority key `ssh+<id>`.
export interface SshHostRecord {
  readonly id: string;
  readonly kind: 'ssh';
  readonly destination: SshHostDestination;
  // this computer's name for the host, passing checkHostName against every other host
  readonly name: string;
  readonly color?: HostTone;
  // platform detection's result, run once per host
  readonly platform?: CachedPlatform;
  // the user's OS choice, which replaces detection
  readonly osOverride?: ShellPlatform;
  // epoch ms of the last connect or folder pick
  readonly lastUsed?: number;
  // native to the host, most recent first
  readonly recentFolders: readonly string[];
  readonly settings: SshHostSettings;
  // the install folder before the last change, null for the default; dropped once an install in the new one succeeded
  readonly previousInstallFolder?: string | null;
  // what Damocles changed on the host, so removing its server undoes only that: the passwordless key it set up (absolute,
  // under ~/.damocles/ssh/), that key's SHA256 fingerprint as installed on the host, and linger it turned on
  readonly identityFile?: string;
  readonly installedKeyFingerprint?: string;
  // the installed key's type and blob ("ssh-ed25519 AAAA..."), and the host file it went into, which removal edits alone
  readonly installedKeyEntry?: string;
  readonly installedKeyFile?: string;
  readonly lingerEnabledByDamocles?: boolean;
  // credential hosts (git over https) this host may use without asking
  readonly alwaysCredentialHosts?: readonly string[];
}

const TARGET_OSES: readonly unknown[] = ['win32', 'darwin', 'linux'] satisfies readonly ShellPlatform[];
// a credential host as git names it in a credential request: host[:port]
const CREDENTIAL_HOST = /^[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;
export const isCredentialHost = (value: unknown): value is string => typeof value === 'string' && CREDENTIAL_HOST.test(value);
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const KEY_ENTRY: RegExp = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
// a host file path as the daemon reported it: absolute on POSIX or Windows, one line
const HOST_FILE = /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]{1,4095}$/;
export const isHostFilePath = (value: unknown): value is string => typeof value === 'string' && HOST_FILE.test(value);

/** What an install appended, kept so removing the server undoes exactly that. */
export interface InstalledKey {
  readonly fingerprint: string;
  readonly entry: string;
  readonly file: string;
}

interface AuthorityRecord {
  readonly projects: readonly RemoteProjectRecord[];
  // target folder keys whose authors the user trusts, matched exactly as trusted-folders.json is
  readonly trusted: readonly string[];
}

interface HostFile {
  // by authority key (project-location.ts); local projects stay in projects.json and trusted-folders.json
  readonly authorities: ReadonlyMap<string, AuthorityRecord>;
  // the sidebar's project keys, local and remote, as last written; read back through order()
  readonly order: readonly string[];
  // by host id, in the order they were saved
  readonly hosts: ReadonlyMap<string, SshHostRecord>;
  // the grouped view's groups by authority key, LOCAL_GROUP for this computer
  readonly groupOrder: readonly string[];
  // the grouped view's collapsed groups by authority key
  readonly collapsedGroups: readonly string[];
}

const EMPTY: HostFile = { authorities: new Map(), order: [], hosts: new Map(), groupOrder: [], collapsedGroups: [] };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// a value ssh reads as an argument: one line, never an option
const isSshWord = (value: unknown): value is string => isText(value) && !value.startsWith('-') && !/[\r\n]/.test(value);

// Host names (docs/invariants.md "Remote daemon and wire"): checked here and nowhere else.
// Control characters, the line and paragraph separators, and the format characters that are no bidi marks (zero-width ones
// would let a look-alike pass the uniqueness check).
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]|(?![\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069])\p{Cf}/u;
// Bidirectional overrides, isolates and marks, which reorder the text around a name in the title bar and in prompts.
const BIDI_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const REFUSED_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** The form a name is stored and compared in: trimmed, NFC. */
export function normalizeHostName(raw: string): string {
  return raw.normalize('NFC').trim();
}

const nameKey = (name: string): string => normalizeHostName(name).toLocaleLowerCase('en');
const codePoints = (text: string): number => [...text].length;

// What a name must not equal: another host's name or ssh alias.
interface NameHolder {
  readonly name: string;
  readonly alias?: string;
}

const holderOf = (record: SshHostRecord): NameHolder => ({ name: record.name, ...(record.destination.kind === 'alias' ? { alias: record.destination.alias } : {}) });

/**
 * The one host name rule: 1..MAX_HOST_NAME_LENGTH characters after trimming and NFC, no control, format or bidirectional
 * characters, and unique ignoring case (toLocaleLowerCase('en')) against every other host's name and ssh alias. alias:
 * the ssh alias of the host being named, which must not equal another host's name either.
 */
export function checkHostName(raw: string, others: readonly NameHolder[], alias?: string): NameCheck {
  const name = normalizeHostName(raw);
  if (name === '') return { ok: false, reason: 'empty' };
  if (CONTROL_CHARS.test(name)) return { ok: false, reason: 'controlChars' };
  if (BIDI_CHARS.test(name)) return { ok: false, reason: 'bidiChars' };
  if (codePoints(name) > MAX_HOST_NAME_LENGTH) return { ok: false, reason: 'tooLong' };
  const key = nameKey(name);
  for (const other of others) {
    if (nameKey(other.name) === key) return { ok: false, reason: 'taken', clashWith: other.name };
    if (other.alias !== undefined && nameKey(other.alias) === key) return { ok: false, reason: 'taken', clashWith: other.alias };
  }
  if (alias !== undefined) {
    const aliasKey = nameKey(alias);
    const clash = others.find((other) => nameKey(other.name) === aliasKey || (other.alias !== undefined && nameKey(other.alias) === aliasKey));
    if (clash) return { ok: false, reason: 'taken', clashWith: clash.name };
  }
  return { ok: true, name };
}

/** A name field's prefill from an alias, host name or distro name: the refused characters removed, trimmed, NFC, within bounds. */
export function prefillHostName(source: string): string {
  return [...normalizeHostName(source.replace(REFUSED_CHARS, ''))].slice(0, MAX_HOST_NAME_LENGTH).join('').trim();
}

/** The prefill made unique against others with a numeric suffix (" 2", " 3", ...), for a record that has no name yet. */
export function uniqueHostName(source: string, others: readonly NameHolder[]): string {
  const base = prefillHostName(source) || 'host';
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '' : ` ${n}`;
    const candidate = `${[...base].slice(0, MAX_HOST_NAME_LENGTH - codePoints(suffix)).join('').trim()}${suffix}`;
    if (checkHostName(candidate, others).ok) return candidate;
  }
}

/** The label a host card shows for its destination: the alias, or user@host:port with an IPv6 host bracketed, as it is typed. */
export function destinationLabel(destination: SshHostDestination): string {
  if (destination.kind === 'alias') return destination.alias;
  const host = destination.host.includes(':') ? `[${destination.host}]` : destination.host;
  return `${destination.user !== undefined ? `${destination.user}@` : ''}${host}${destination.port !== undefined ? `:${destination.port}` : ''}`;
}

/** The OS a host's paths follow: the user's override, else what detection found. */
export function hostOs(record: SshHostRecord): ShellPlatform | undefined {
  return record.osOverride ?? record.platform?.os;
}

/** Whether ssh forwards the agent to the host: its switch is on and the host is known to be a POSIX one. */
export function forwardsAgent(record: SshHostRecord): boolean {
  const os = hostOs(record);
  return record.settings.forwardAgent === true && os !== undefined && os !== 'win32';
}

export const sshAuthorityKey = (hostId: string): string => `ssh+${hostId}`;

/** The host id of an ssh authority key, or undefined for any other authority. */
export function hostIdOfAuthority(authorityKey: string): string | undefined {
  if (!authorityKey.startsWith('ssh+')) return undefined;
  const id = authorityKey.slice('ssh+'.length);
  return HOST_ID.test(id) ? id : undefined;
}

function parseProject(value: unknown): RemoteProjectRecord | undefined {
  if (!isRecordValue(value)) return undefined;
  const os = own(value, 'os');
  const folder = own(value, 'path');
  const key = own(value, 'folderKey');
  if (!isText(folder) || !isText(key) || !TARGET_OSES.includes(os)) return undefined;
  return { path: folder, folderKey: key, os: os as ShellPlatform };
}

function parseAuthority(value: unknown): AuthorityRecord {
  const record = isRecordValue(value) ? value : {};
  const listed = own(record, 'projects');
  const trustedList = own(record, 'trusted');
  const projects = Array.isArray(listed) ? listed.flatMap((entry) => parseProject(entry) ?? []) : [];
  const unique = projects.filter((project, index) => projects.findIndex((other) => other.folderKey === project.folderKey) === index);
  const trusted = Array.isArray(trustedList) ? [...new Set(trustedList.filter(isText))] : [];
  return { projects: unique, trusted };
}

function parseDestination(value: unknown): SshHostDestination | undefined {
  if (!isRecordValue(value)) return undefined;
  const kind = own(value, 'kind');
  if (kind === 'alias') {
    const alias = own(value, 'alias');
    return isSshWord(alias) ? { kind, alias } : undefined;
  }
  if (kind !== 'address') return undefined;
  const host = own(value, 'host');
  const user = own(value, 'user');
  const port = own(value, 'port');
  const options = own(value, 'options');
  if (!isSshWord(host) || (user !== undefined && !isSshWord(user))) return undefined;
  if (port !== undefined && !(typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535)) return undefined;
  if (!Array.isArray(options)) return undefined;
  const parsed: Array<{ name: string; value: string }> = [];
  for (const option of options) {
    if (!isRecordValue(option)) return undefined;
    const name = own(option, 'name');
    const optionValue = own(option, 'value');
    if (!isSshWord(name) || !isSshWord(optionValue)) return undefined;
    parsed.push({ name, value: optionValue });
  }
  return { kind, host, ...(user !== undefined ? { user } : {}), ...(port !== undefined ? { port } : {}), options: parsed };
}

function parseSettings(id: string, value: unknown, log: (line: string) => void): SshHostSettings {
  if (!isRecordValue(value)) return {};
  const installFolder = own(value, 'installFolder');
  const mode = own(value, 'defaultPermissionMode');
  if (mode !== undefined && !PERMISSION_MODES.includes(mode as PermissionMode)) log(`[hosts] dropping the default permission mode of ${id}: not a mode`);
  const switches = HOST_SWITCH_KEYS.filter((key) => own(value, key) === true);
  return {
    ...(isText(installFolder) ? { installFolder } : {}),
    ...(PERMISSION_MODES.includes(mode as PermissionMode) ? { defaultPermissionMode: mode as PermissionMode } : {}),
    ...Object.fromEntries(switches.map((key) => [key, true])),
  };
}

function parsePlatform(value: unknown): CachedPlatform | undefined {
  if (!isRecordValue(value)) return undefined;
  const os = own(value, 'os');
  const shell = own(value, 'windowsShell');
  if (!TARGET_OSES.includes(os) || (shell !== undefined && shell !== 'cmd' && shell !== 'powershell')) return undefined;
  return { os: os as ShellPlatform, ...(shell !== undefined ? { windowsShell: shell as 'cmd' | 'powershell' } : {}) };
}

// A record as written, its name not yet checked against the others (parseHostFile does, in file order).
function parseHost(id: string, value: unknown, log: (line: string) => void): (Omit<SshHostRecord, 'name'> & { readonly name?: string }) | undefined {
  if (!HOST_ID.test(id) || !isRecordValue(value) || own(value, 'kind') !== 'ssh') return undefined;
  const destination = parseDestination(own(value, 'destination'));
  if (!destination) return undefined;
  const name = own(value, 'name');
  const color = own(value, 'color');
  const platform = parsePlatform(own(value, 'platform'));
  const osOverride = own(value, 'osOverride');
  const lastUsed = own(value, 'lastUsed');
  const recent = own(value, 'recentFolders');
  const previous = own(value, 'previousInstallFolder');
  const identityFile = own(value, 'identityFile');
  const fingerprint = own(value, 'installedKeyFingerprint');
  const keyEntry = own(value, 'installedKeyEntry');
  const keyFile = own(value, 'installedKeyFile');
  const installed = typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint) && typeof keyEntry === 'string' && KEY_ENTRY.test(keyEntry) && typeof keyFile === 'string' && HOST_FILE.test(keyFile);
  const always = own(value, 'alwaysCredentialHosts');
  // only a palette tone is a color; anything else (an earlier '#rrggbb') is refused here, never shown
  if (color !== undefined && !isHostTone(color)) log(`[hosts] dropping the color of ${id}: not a palette tone`);
  return {
    id,
    kind: 'ssh',
    destination,
    ...(typeof name === 'string' ? { name } : {}),
    ...(isHostTone(color) ? { color } : {}),
    ...(platform ? { platform } : {}),
    ...(TARGET_OSES.includes(osOverride) ? { osOverride: osOverride as ShellPlatform } : {}),
    ...(typeof lastUsed === 'number' && Number.isFinite(lastUsed) && lastUsed > 0 ? { lastUsed } : {}),
    recentFolders: Array.isArray(recent) ? [...new Set(recent.filter(isText))].slice(0, MAX_RECENT_FOLDERS) : [],
    settings: parseSettings(id, own(value, 'settings'), log),
    ...(previous === null || isText(previous) ? { previousInstallFolder: previous } : {}),
    ...(isText(identityFile) && path.isAbsolute(identityFile) ? { identityFile } : {}),
    ...(installed ? { installedKeyFingerprint: fingerprint, installedKeyEntry: keyEntry, installedKeyFile: keyFile } : {}),
    ...(own(value, 'lingerEnabledByDamocles') === true ? { lingerEnabledByDamocles: true } : {}),
    ...(Array.isArray(always) ? { alwaysCredentialHosts: [...new Set(always.filter(isCredentialHost))] } : {}),
  };
}

function parseHostFile(text: string, log: (line: string) => void): HostFile {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecordValue(parsed) || own(parsed, 'version') !== SCHEMA_VERSION || !isRecordValue(own(parsed, 'authorities'))) {
    throw new Error('unknown schema');
  }
  const authorities = new Map<string, AuthorityRecord>();
  for (const [key, value] of Object.entries(own(parsed, 'authorities') as Record<string, unknown>)) {
    if (isText(key) && key !== 'local') authorities.set(key, parseAuthority(value));
  }
  const listedOrder = own(parsed, 'order');
  const order = Array.isArray(listedOrder) ? [...new Set(listedOrder.filter(isText))] : [];
  const hosts = new Map<string, SshHostRecord>();
  const rawHosts = own(parsed, 'hosts');
  for (const [id, value] of Object.entries(isRecordValue(rawHosts) ? rawHosts : {})) {
    const host = parseHost(id, value, log);
    if (!host) {
      log(`[hosts] dropping the malformed host record ${JSON.stringify(id).slice(0, 80)}`);
      continue;
    }
    const others = [...hosts.values()].map(holderOf);
    const alias = host.destination.kind === 'alias' ? host.destination.alias : undefined;
    const check = host.name === undefined ? undefined : checkHostName(host.name, others);
    // an older record has no name, and a hand-edited one may break the rule: either gets its alias or host name, made unique
    const name = check?.ok ? check.name : uniqueHostName(alias ?? (host.destination.kind === 'address' ? host.destination.host : id), others);
    if (check && !check.ok) log(`[hosts] the host ${id} had a name the rules refuse (${check.reason}); it is named ${name}`);
    hosts.set(id, { ...host, name });
  }
  return { authorities, order, hosts, groupOrder: textSet(own(parsed, 'groupOrder')), collapsedGroups: textSet(own(parsed, 'collapsedGroups')) };
}

function textSet(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isText))] : [];
}

// The stored keys still listed, in stored order, then every listed key the store lacks, in list order.
function reconciled(stored: readonly string[], listed: readonly string[]): string[] {
  const known = new Set(listed);
  const kept = stored.filter((key) => known.has(key));
  const placed = new Set(kept);
  return [...kept, ...listed.filter((key) => !placed.has(key))];
}

/** Whether next holds exactly the keys of current, each once, in any order. */
export function isPermutationOf(next: readonly string[], current: readonly string[]): boolean {
  const keys = new Set(current);
  return next.length === current.length && keys.size === current.length && new Set(next).size === next.length && next.every((key) => keys.has(key));
}

// The stored keys, then every listed key they lack; a stored key not listed (hidden by the remote gate) keeps its slot.
function withListed(stored: readonly string[], listed: readonly string[]): string[] {
  const placed = new Set(stored);
  return [...stored, ...listed.filter((key) => !placed.has(key))];
}

// The listed keys' slots filled with next in turn; undefined when next is not a permutation of listed.
function reorder(stored: readonly string[], listed: readonly string[], next: readonly string[]): string[] | undefined {
  if (!isPermutationOf(next, listed)) return undefined;
  const shown = new Set(listed);
  let at = 0;
  return withListed(stored, listed).map((key) => (shown.has(key) ? next[at++]! : key));
}

// key moved right after `after`, or to the end when after is undefined or not in order.
function placedAfter(order: readonly string[], key: string, after: string | undefined): string[] {
  const rest = order.filter((candidate) => candidate !== key);
  const at = after === undefined ? -1 : rest.indexOf(after);
  return at < 0 ? [...rest, key] : [...rest.slice(0, at + 1), key, ...rest.slice(at + 1)];
}

/** The grouped view's groups of the shown project keys, by authority key in first-appearance order; LOCAL_GROUP always, first when no local project shows. */
export function groupsOf(projectKeys: readonly string[]): string[] {
  const groups = new Set(projectKeys.map(authorityKeyOfProject));
  return groups.has(LOCAL_GROUP) ? [...groups] : [LOCAL_GROUP, ...groups];
}

// The fields of a new host the caller chooses; the store draws its id.
export interface NewSshHost {
  readonly destination: SshHostDestination;
  readonly name: string;
}

export type AddHostResult = { readonly ok: true; readonly host: SshHostRecord } | { readonly ok: false; readonly check: NameCheck };

/**
 * Remote projects, their trust, the sidebar order and the saved SSH hosts, in remote-hosts.json, so projects.json and
 * trusted-folders.json keep the shape an older app version reads after a downgrade.
 */
export class HostStore {
  readonly filePath: string;
  private file: HostFile;
  private readonly listeners = new Set<() => void>();
  // why the file did not parse at launch (a hand edit, a newer version's schema); while set, every write is refused
  private readonly readError: string | undefined;

  private constructor(filePath: string, file: HostFile, readError?: string) {
    this.filePath = filePath;
    this.file = file;
    this.readError = readError;
  }

  /**
   * Reads the file; a missing one is empty. One that does not parse or names another schema shows nothing and refuses every
   * write for the run, so neither a typo nor a downgrade replaces the hosts it holds.
   */
  static async open(userDataDir: string, log: (line: string) => void): Promise<HostStore> {
    const filePath = path.join(userDataDir, HOST_STORE_FILE);
    let text: string | undefined;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return new HostStore(filePath, EMPTY);
    try {
      return new HostStore(filePath, parseHostFile(text, log));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[hosts] ${filePath} does not parse (${reason}); showing no hosts and refusing every write`);
      return new HostStore(filePath, EMPTY, reason);
    }
  }

  /** Why remote-hosts.json did not parse; undefined while it is read and written normally. */
  unreadable(): string | undefined {
    return this.readError;
  }

  /** Each authority's projects, in the order they were added. */
  projects(): ReadonlyArray<{ readonly authorityKey: string; readonly project: RemoteProjectRecord }> {
    return [...this.file.authorities].flatMap(([authorityKey, record]) => record.projects.map((project) => ({ authorityKey, project })));
  }

  isTrusted(authorityKey: string, folderKey: string): boolean {
    return this.file.authorities.get(authorityKey)?.trusted.includes(folderKey) === true;
  }

  /** The sidebar's keys: the stored order without keys no longer listed, then every listed key it lacks, in list order. */
  order(listed: readonly string[]): string[] {
    return reconciled(this.file.order, listed);
  }

  /** The grouped view's group order: the stored order of the listed groups, then the listed groups it lacks. */
  groups(listedGroups: readonly string[]): string[] {
    return reconciled(this.file.groupOrder, listedGroups);
  }

  /** The collapsed groups as stored, shown or not. */
  collapsedGroups(): readonly string[] {
    return this.file.collapsedGroups;
  }

  /**
   * Writes the sidebar order: the keys listed when the write runs, in the sequence of order. Refuses, writing nothing, an
   * order that is not a permutation of them; a stored key not listed keeps its slot.
   */
  async setOrder(order: readonly string[], listed: () => readonly string[]): Promise<boolean> {
    let accepted = false;
    await this.change((file) => {
      const next = reorder(file.order, listed(), order);
      if (!next) return file;
      accepted = true;
      return { ...file, order: next };
    });
    return accepted;
  }

  /** setOrder's rule for the grouped view's group order. */
  async setGroupOrder(groupOrder: readonly string[], listedGroups: () => readonly string[]): Promise<boolean> {
    let accepted = false;
    await this.change((file) => {
      const next = reorder(file.groupOrder, listedGroups(), groupOrder);
      if (!next) return file;
      accepted = true;
      return { ...file, groupOrder: next };
    });
    return accepted;
  }

  /** Collapses or expands a group listed when the write runs; any other group is refused. */
  async setGroupCollapsed(group: string, collapsed: boolean, listedGroups: () => readonly string[]): Promise<void> {
    await this.change((file) => {
      if (!listedGroups().includes(group)) throw new Error(`No project group ${group}`);
      if (file.collapsedGroups.includes(group) === collapsed) return file;
      return { ...file, collapsedGroups: collapsed ? [...file.collapsedGroups, group] : file.collapsedGroups.filter((other) => other !== group) };
    });
  }

  /** Places projectKey right after `after` in the sidebar order, listed being the keys shown when the write runs. */
  async placeAfter(projectKey: string, after: string, listed: () => readonly string[]): Promise<void> {
    await this.change((file) => ({ ...file, order: placedAfter(withListed(file.order, listed()), projectKey, after) }));
  }

  /** The saved SSH hosts, in the order they were saved. */
  hosts(): readonly SshHostRecord[] {
    return [...this.file.hosts.values()];
  }

  host(hostId: string): SshHostRecord | undefined {
    return this.file.hosts.get(hostId);
  }

  /** The grouped view's host order as stored. */
  groupOrder(): readonly string[] {
    return this.file.groupOrder;
  }

  /** checkHostName against every saved host but hostId (the host being renamed). */
  checkName(name: string, hostId?: string, alias?: string): NameCheck {
    return checkHostName(name, this.othersThan(hostId), alias);
  }

  /** Saves a new host once its name passes against the hosts as they are when the write runs. */
  async addHost(host: NewSshHost): Promise<AddHostResult> {
    let result: AddHostResult = { ok: false, check: { ok: false, reason: 'empty' } };
    await this.change((file) => {
      const alias = host.destination.kind === 'alias' ? host.destination.alias : undefined;
      const check = checkHostName(host.name, [...file.hosts.values()].map(holderOf), alias);
      if (!check.ok) {
        result = { ok: false, check };
        return file;
      }
      let id = randomBytes(9).toString('base64url');
      while (file.hosts.has(id)) id = randomBytes(9).toString('base64url');
      const record: SshHostRecord = { id, kind: 'ssh', destination: host.destination, name: check.name, recentFolders: [], settings: {} };
      result = { ok: true, host: record };
      return { ...file, hosts: new Map(file.hosts).set(id, record) };
    });
    return result;
  }

  /** Renames a host when the name passes against the other hosts as they are when the write runs; a refusal writes nothing. */
  async renameHost(hostId: string, name: string): Promise<NameCheck> {
    let result: NameCheck = { ok: false, reason: 'empty' };
    await this.change((file) => {
      const record = file.hosts.get(hostId);
      if (!record) throw new Error(`No saved host ${hostId}`);
      result = checkHostName(name, [...file.hosts.values()].filter((other) => other.id !== hostId).map(holderOf));
      if (!result.ok || result.name === record.name) return file;
      return this.withHost(file, { ...record, name: result.name });
    });
    return result;
  }

  /** Records a connect or a folder pick: lastUsed now, and folder first among the recent folders. */
  async touchHost(hostId: string, folder?: string): Promise<void> {
    await this.updateHost(hostId, (record) => ({
      ...record,
      lastUsed: Date.now(),
      recentFolders: folder === undefined ? record.recentFolders : [folder, ...record.recentFolders.filter((other) => other !== folder)].slice(0, MAX_RECENT_FOLDERS),
    }));
  }

  /** Platform detection's result, kept so it runs once per host. */
  async savePlatform(hostId: string, platform: CachedPlatform): Promise<void> {
    await this.updateHost(hostId, (record) => ({ ...record, platform }));
  }

  /**
   * The host's install folder (null: ~/.damocles/server). The folder in use before is kept as previousInstallFolder until an
   * install in the new one succeeded; a change before that keeps the folder that still holds the installed versions.
   */
  async setInstallFolder(hostId: string, folder: string | null): Promise<void> {
    await this.updateHost(hostId, (record) => {
      const current = record.settings.installFolder ?? null;
      if (current === folder) return record;
      const { previousInstallFolder, settings: { installFolder: _installFolder, ...settings }, ...rest } = record;
      const previous = previousInstallFolder !== undefined ? previousInstallFolder : current;
      return { ...rest, settings: folder === null ? settings : { ...settings, installFolder: folder }, ...(previous !== folder ? { previousInstallFolder: previous } : {}) };
    });
  }

  /** One Settings > Remote hosts change; null clears the value, false turns a switch off. */
  async setHostSetting(hostId: string, change: HostSettingChange): Promise<void> {
    await this.updateHost(hostId, (record) => {
      switch (change.key) {
        case 'color': {
          const { color: _color, ...rest } = record;
          return change.value === null ? rest : { ...rest, color: change.value };
        }
        case 'osOverride': {
          const { osOverride: _os, ...rest } = record;
          return change.value === null ? rest : { ...rest, osOverride: change.value };
        }
        case 'defaultPermissionMode': {
          const { defaultPermissionMode: _mode, ...settings } = record.settings;
          return { ...record, settings: change.value === null ? settings : { ...settings, defaultPermissionMode: change.value } };
        }
        default: {
          const { [change.key]: _switch, ...settings } = record.settings;
          return { ...record, settings: change.value ? { ...settings, [change.key]: true } : settings };
        }
      }
    });
  }

  /** Set up passwordless login appended Damocles' key line on the host, whether or not its check passes afterwards. */
  async recordInstalledKey(hostId: string, installed: InstalledKey): Promise<void> {
    if (!(FINGERPRINT.test(installed.fingerprint) && KEY_ENTRY.test(installed.entry) && HOST_FILE.test(installed.file))) throw new Error('Not an installed key record');
    await this.updateHost(hostId, (record) => ({ ...record, installedKeyFingerprint: installed.fingerprint, installedKeyEntry: installed.entry, installedKeyFile: installed.file }));
  }

  /** Passwordless login set up and verified: the key ssh is given from now on. */
  async recordPasswordless(hostId: string, identityFile: string): Promise<void> {
    if (!path.isAbsolute(identityFile)) throw new Error('Not an absolute identity file');
    await this.updateHost(hostId, (record) => ({ ...record, identityFile }));
  }

  /** The removal took out the key Damocles installed: ssh stops offering it. */
  async clearInstalledKey(hostId: string): Promise<void> {
    await this.updateHost(hostId, ({ identityFile: _file, installedKeyFingerprint: _fingerprint, installedKeyEntry: _entry, installedKeyFile: _keyFile, ...rest }) => rest);
  }

  /** Allow background work turned linger on, so removing the server may turn it off. */
  async recordLingerEnabled(hostId: string): Promise<void> {
    await this.updateHost(hostId, (record) => (record.lingerEnabledByDamocles ? record : { ...record, lingerEnabledByDamocles: true }));
  }

  async clearLingerEnabled(hostId: string): Promise<void> {
    await this.updateHost(hostId, ({ lingerEnabledByDamocles: _linger, ...rest }) => rest);
  }

  /** "Always for <host>": the credential host this host may use without asking. */
  async addAlwaysCredentialHost(hostId: string, credentialHost: string): Promise<void> {
    if (!isCredentialHost(credentialHost)) throw new Error('Not a credential host');
    await this.updateHost(hostId, (record) => {
      const listed = record.alwaysCredentialHosts ?? [];
      return listed.includes(credentialHost) ? record : { ...record, alwaysCredentialHosts: [...listed, credentialHost] };
    });
  }

  /** Revoke, or an erase from the target: the pair asks again. */
  async revokeCredentialHost(hostId: string, credentialHost: string): Promise<void> {
    await this.updateHost(hostId, (record) => {
      const listed = record.alwaysCredentialHosts ?? [];
      return listed.includes(credentialHost) ? { ...record, alwaysCredentialHosts: listed.filter((other) => other !== credentialHost) } : record;
    });
  }

  /** Forget host: its record, its authority's projects and trust, and its keys in the sidebar and group orders. */
  async forgetHost(hostId: string): Promise<void> {
    const authorityKey = sshAuthorityKey(hostId);
    await this.change((file) => {
      if (!file.hosts.has(hostId)) throw new Error(`No saved host ${hostId}`);
      const hosts = new Map(file.hosts);
      hosts.delete(hostId);
      const authorities = new Map(file.authorities);
      authorities.delete(authorityKey);
      return {
        authorities,
        hosts,
        order: file.order.filter((key) => authorityKeyOfProject(key) !== authorityKey),
        groupOrder: file.groupOrder.filter((key) => key !== authorityKey),
        collapsedGroups: file.collapsedGroups.filter((key) => key !== authorityKey),
      };
    });
  }

  /** The first install in the new install folder succeeded and cleaned the previous one. */
  async installFolderSettled(hostId: string): Promise<void> {
    await this.updateHost(hostId, (record) => {
      if (record.previousInstallFolder === undefined) return record;
      const { previousInstallFolder: _previous, ...rest } = record;
      return rest;
    });
  }

  /**
   * Adds the project right after `after` in the sidebar order, else at its end, listed being the keys shown when the write
   * runs; resolves false when the authority already lists the folder.
   */
  addProject(authorityKey: string, project: RemoteProjectRecord, projectKey: string, listed: () => readonly string[], after?: string): Promise<boolean> {
    return this.change((file) => {
      const record = file.authorities.get(authorityKey) ?? { projects: [], trusted: [] };
      if (record.projects.some((candidate) => candidate.folderKey === project.folderKey)) return file;
      return {
        ...file,
        authorities: new Map(file.authorities).set(authorityKey, { ...record, projects: [...record.projects, project] }),
        order: placedAfter(withListed(file.order, listed()), projectKey, after),
      };
    });
  }

  async removeProject(authorityKey: string, folderKey: string, projectKey: string): Promise<void> {
    await this.change((file) => {
      const record = file.authorities.get(authorityKey);
      if (!record?.projects.some((project) => project.folderKey === folderKey)) return file;
      return {
        ...file,
        authorities: new Map(file.authorities).set(authorityKey, { ...record, projects: record.projects.filter((project) => project.folderKey !== folderKey) }),
        order: file.order.filter((key) => key !== projectKey),
      };
    });
  }

  /** Drops a removed local project's key from the sidebar order, as removeProject does for a remote one. */
  async removeFromOrder(projectKey: string): Promise<void> {
    await this.change((file) => (file.order.includes(projectKey) ? { ...file, order: file.order.filter((key) => key !== projectKey) } : file));
  }

  async grantTrust(authorityKey: string, folderKey: string): Promise<void> {
    await this.change((file) => {
      const record = file.authorities.get(authorityKey) ?? { projects: [], trusted: [] };
      if (record.trusted.includes(folderKey)) return file;
      return { ...file, authorities: new Map(file.authorities).set(authorityKey, { ...record, trusted: [...record.trusted, folderKey] }) };
    });
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private othersThan(hostId: string | undefined): NameHolder[] {
    return this.hosts().filter((other) => other.id !== hostId).map(holderOf);
  }

  private withHost(file: HostFile, record: SshHostRecord): HostFile {
    return { ...file, hosts: new Map(file.hosts).set(record.id, record) };
  }

  private async updateHost(hostId: string, apply: (record: SshHostRecord) => SshHostRecord): Promise<void> {
    await this.change((file) => {
      const record = file.hosts.get(hostId);
      if (!record) throw new Error(`No saved host ${hostId}`);
      const next = apply(record);
      return next === record ? file : this.withHost(file, next);
    });
  }

  // Applied inside the serialised write and kept only once it has landed; resolves whether the file changed.
  private async change(apply: (file: HostFile) => HostFile): Promise<boolean> {
    if (this.readError !== undefined) throw new Error(`${this.filePath} could not be read, so it is not changed: ${this.readError}`);
    let next: HostFile = this.file;
    await writeJsonConfig(this.filePath, () => {
      next = apply(this.file);
      return `${JSON.stringify({
        version: SCHEMA_VERSION,
        authorities: Object.fromEntries(next.authorities),
        order: next.order,
        hosts: Object.fromEntries(next.hosts),
        groupOrder: next.groupOrder,
        collapsedGroups: next.collapsedGroups,
      }, null, 2)}\n`;
    });
    if (next === this.file) return false;
    this.file = next;
    for (const listener of [...this.listeners]) listener();
    return true;
  }
}
