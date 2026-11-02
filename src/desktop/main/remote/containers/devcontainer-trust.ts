import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { MAX_DEVCONTAINER_TRUST_TEXT, MAX_DEVCONTAINER_TRUST_VALUES, type DevcontainerTrustEntry, type DevcontainerTrustItems, type DevcontainerTrustValue } from '../../../preload/overlay-channels';
import { visibleLines } from '../../../../shared/visible-text';

// What is listed and hashed, and why: docs/invariants.md "Dev container trust".

export type DevcontainerTrustErrorCode = 'malformed' | 'tooLarge' | 'composeUnsupported';

/** The resolved configuration cannot be shown truthfully, so nothing may run. */
export class DevcontainerTrustError extends Error {
  override readonly name = 'DevcontainerTrustError';
  readonly code: DevcontainerTrustErrorCode;
  constructor(code: DevcontainerTrustErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the confirmation shows, and the hash of the structured values behind it. */
export interface DevcontainerTrust {
  readonly items: DevcontainerTrustItems;
  readonly hash: string;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Command = string | readonly string[];
type HostCommand = Command | Readonly<Record<string, Command>>;

// Bumping the version re-asks every stored confirmation once.
const HASH_DOMAIN = 'damocles.devcontainer-trust/1\n';

const malformed = (message: string): DevcontainerTrustError => new DevcontainerTrustError('malformed', `read-configuration output: ${message}`);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Own properties only; rebuilt objects use Object.fromEntries, which keeps a `__proto__` key as plain data.
function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function optionalString(record: Readonly<Record<string, unknown>>, key: string, where: string): string | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw malformed(`${where}${key} is not a string`);
  return value;
}

function stringList(record: Readonly<Record<string, unknown>>, key: string, where: string): readonly string[] {
  const value = own(record, key);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) throw malformed(`${where}${key} is not a list of strings`);
  return value;
}

function optionalBoolean(record: Readonly<Record<string, unknown>>, key: string, where: string): boolean {
  const value = own(record, key);
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw malformed(`${where}${key} is not a boolean`);
  return value;
}

function command(value: unknown, where: string): Command {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) return value;
  throw malformed(`${where} is not a string or a list of strings`);
}

// The CLI runs nothing for a blank string, an empty list or an empty object (runInitializeCommand).
function hostCommand(value: unknown): HostCommand | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    const single = command(value, 'initializeCommand');
    return (typeof single === 'string' ? single.trim() === '' : single.length === 0) ? undefined : single;
  }
  const names = Object.keys(value);
  return names.length === 0 ? undefined : Object.fromEntries(names.map((name) => [name, command(value[name], `initializeCommand.${name}`)]));
}

// A mount object becomes the `--mount` text the CLI builds from it (generateMountCommand), so both forms read alike.
function mountText(value: unknown, index: number): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) throw malformed(`mounts[${index}] is not a string or a mount object`);
  const type = optionalString(value, 'type', `mounts[${index}].`);
  const source = optionalString(value, 'source', `mounts[${index}].`);
  const target = optionalString(value, 'target', `mounts[${index}].`);
  if (type === undefined || target === undefined) throw malformed(`mounts[${index}] has no type or target`);
  return `type=${type},${source ? `src=${source},` : ''}dst=${target}`;
}

function featureOptions(value: unknown, id: string): Json {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (!isRecord(value)) throw malformed(`features["${id}"] options are not a string, a boolean or an object`);
  // the CLI writes every option as `KEY="${value}"`, so a number or null runs as its text
  return Object.fromEntries(Object.keys(value).map((key) => {
    const option = value[key];
    if (typeof option !== 'string' && typeof option !== 'boolean' && typeof option !== 'number' && option !== null) throw malformed(`features["${id}"].${key} is not a string, a number, a boolean or null`);
    return [key, option];
  }));
}

// `appPort` reaches `docker run -p`: a number binds loopback only, a string is docker's own publish spec.
function appPorts(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list.map((port, index) => {
    if (typeof port === 'number' && Number.isInteger(port)) return `127.0.0.1:${port}:${port}`;
    if (typeof port === 'string') return port;
    throw malformed(`appPort[${index}] is not a port number or a string`);
  });
}

function gpuRequirement(value: unknown): Json {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw malformed('hostRequirements is not an object');
  const gpu = own(value, 'gpu');
  if (gpu === undefined || gpu === null || gpu === false) return null;
  if (gpu === true || gpu === 'optional') return gpu;
  if (!isRecord(gpu)) throw malformed('hostRequirements.gpu is not a boolean, "optional" or an object');
  return Object.fromEntries(Object.keys(gpu).map((key) => {
    const entry = gpu[key];
    if (typeof entry !== 'string' && typeof entry !== 'number') throw malformed(`hostRequirements.gpu.${key} is not a string or a number`);
    return [key, entry];
  }));
}

// JSON with every object's keys sorted, so equal values always encode alike.
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, Json>>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const DEFAULT_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock'];
// case-blind: Windows pipe names and Docker Desktop's host paths are
const SOCKET_NAME = /^(?:docker\.sock(?:\.raw)?|podman\.sock|docker_engine|podman-machine-default)$/i;
const USER_RUNTIME_DIR = /^\/run\/user(?:\/\d+(?:\/(?:podman|docker))?)?$/;

// The path the kernel resolves: `//`, `.` and `..` folded; the Windows device namespace (`\\.\pipe\…`) keeps its leading `//`.
function hostPathOf(hostPath: string): string {
  const slashed = hostPath.replaceAll('\\', '/');
  const device = /^\/\/[.?]\//.exec(slashed)?.[0] ?? '';
  return (device + path.posix.normalize(slashed.slice(device.length))).replace(/\/+$/, '') || '/';
}

// A host path that is an engine socket or a folder holding one gives the container control of the engine, so of the host.
function exposesEngineSocket(hostPath: string): boolean {
  const normalized = hostPathOf(hostPath);
  if (SOCKET_NAME.test(normalized.slice(normalized.lastIndexOf('/') + 1))) return true;
  if (USER_RUNTIME_DIR.test(normalized)) return true;
  return DEFAULT_SOCKETS.some((socket) => socket === normalized || socket.startsWith(normalized === '/' ? '/' : `${normalized}/`));
}

// docker reads `--mount` as one CSV record; a quoted field may hold commas.
function csvFields(text: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

// A `--mount` value that binds an engine socket. docker's default `--mount` type is a volume, which names no host path unless
// the local driver's `volume-opt=device=` binds one.
function mountExposesSocket(spec: string): boolean {
  let type = 'volume';
  let source: string | undefined;
  let device: string | undefined;
  for (const field of csvFields(spec)) {
    const eq = field.indexOf('=');
    const key = (eq < 0 ? field : field.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : field.slice(eq + 1);
    if (key === 'type') type = value.toLowerCase();
    else if (key === 'source' || key === 'src') source = value;
    else if (key === 'volume-opt' && value.startsWith('device=')) device = value.slice('device='.length);
  }
  if (type === 'volume') return device !== undefined && exposesEngineSocket(device);
  return source !== undefined && exposesEngineSocket(source);
}

// A `-v` value is `source:target[:options]`; a source without a slash is a named volume, and `C:` starts a Windows path.
function volumeExposesSocket(spec: string): boolean {
  const drive = /^[A-Za-z]:[\\/]/.test(spec) ? 2 : 0;
  const colon = spec.indexOf(':', drive);
  const source = colon < 0 ? spec : spec.slice(0, colon);
  return /[\\/]/.test(source) && exposesEngineSocket(source);
}

// An empty value still reaches docker as an argument, so it shows as `""` rather than as nothing.
const shownText = (text: string): string => (text === '' ? '""' : visibleLines(text));

const PRIVILEGED_ARG = /^--privileged(?:=(.*))?$/;
// pflag reads the letters of a shorthand group before its last flag as boolean flags (`-tv/a:/b`, `-itv /a:/b`); a group whose
// earlier letter takes a value is over-marked, never missed
const SHORT_VOLUME_GROUP = /^-[A-Za-z]*v$/;
const SHORT_VOLUME_VALUE = /^-[A-Za-z]*v=?(.+)$/s;
// docker's boolean flag parser; any other value is an error docker reports, never an unprivileged run.
const FALSE_FLAG = new Set(['0', 'f', 'F', 'false', 'FALSE', 'False']);

function runArgValues(runArgs: readonly string[]): DevcontainerTrustValue[] {
  return runArgs.map((arg, index) => {
    const privileged = PRIVILEGED_ARG.exec(arg);
    if (privileged && (privileged[1] === undefined || !FALSE_FLAG.has(privileged[1]))) return { text: shownText(arg), danger: 'privileged' };
    const previous = index > 0 ? runArgs[index - 1] : undefined;
    const volume = previous !== undefined && (SHORT_VOLUME_GROUP.test(previous) || previous === '--volume') ? arg : (SHORT_VOLUME_VALUE.exec(arg) ?? /^--volume=(.+)$/s.exec(arg))?.[1];
    const mount = previous === '--mount' ? arg : /^--mount=(.+)$/s.exec(arg)?.[1];
    const socket = (volume !== undefined && volumeExposesSocket(volume)) || (mount !== undefined && mountExposesSocket(mount));
    return socket ? { text: shownText(arg), danger: 'dockerSocket' } : { text: shownText(arg) };
  });
}

const shown = (text: string): DevcontainerTrustValue => ({ text: shownText(text) });
const commandText = (value: Command): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** Reads `devcontainer read-configuration --include-merged-configuration` output, untrusted; throws DevcontainerTrustError. */
export function devcontainerTrustFrom(resolved: unknown): DevcontainerTrust {
  if (!isRecord(resolved)) throw malformed('not a JSON object');
  const merged = own(resolved, 'mergedConfiguration');
  if (!isRecord(merged)) throw malformed('no mergedConfiguration (run with --include-merged-configuration)');
  // Compose files decide the container's mounts and privileges themselves, outside anything this confirmation can list.
  if (own(merged, 'dockerComposeFile') !== undefined) {
    throw new DevcontainerTrustError('composeUnsupported', 'Docker Compose dev container configurations are not supported');
  }

  const initializeCommand = hostCommand(own(merged, 'initializeCommand'));
  const mountsValue = own(merged, 'mounts');
  if (mountsValue !== undefined && mountsValue !== null && !Array.isArray(mountsValue)) throw malformed('mounts is not a list');
  const mounts = ((mountsValue ?? []) as unknown[]).map(mountText);
  const workspaceMount = optionalString(merged, 'workspaceMount', '');
  const runArgs = stringList(merged, 'runArgs', '');
  const privileged = optionalBoolean(merged, 'privileged', '');
  const capAdd = stringList(merged, 'capAdd', '');
  const securityOpt = stringList(merged, 'securityOpt', '');
  const featuresValue = own(merged, 'features');
  if (featuresValue !== undefined && featuresValue !== null && !isRecord(featuresValue)) throw malformed('features is not an object');
  const features: [string, Json][] = Object.keys(featuresValue ?? {}).sort().map((id) => [id, featureOptions((featuresValue as Record<string, unknown>)[id], id)]);
  const appPort = appPorts(own(merged, 'appPort'));
  const buildValue = own(merged, 'build');
  if (buildValue !== undefined && buildValue !== null && !isRecord(buildValue)) throw malformed('build is not an object');
  const build = buildValue ?? {};
  const buildOptions = stringList(build, 'options', 'build.');
  const buildContext = optionalString(build, 'context', 'build.') ?? optionalString(merged, 'context', '');
  const gpu = gpuRequirement(own(merged, 'hostRequirements'));

  const hashed: Json = {
    initializeCommand: initializeCommand ?? null,
    mounts,
    workspaceMount: workspaceMount ?? null,
    runArgs,
    privileged,
    capAdd,
    securityOpt,
    features,
    appPort,
    buildOptions,
    buildContext: buildContext ?? null,
    gpu,
  };
  const hash = createHash('sha256').update(HASH_DOMAIN + canonical(hashed)).digest('hex');

  const initializeValues = initializeCommand === undefined ? []
    : typeof initializeCommand === 'string' || Array.isArray(initializeCommand) ? [shown(commandText(initializeCommand as Command))]
    : Object.entries(initializeCommand as Readonly<Record<string, Command>>).map(([name, entry]) => shown(`${name}: ${commandText(entry)}`));
  const socketDanger = (text: string, exposes: boolean): DevcontainerTrustValue => (exposes ? { text: shownText(text), danger: 'dockerSocket' } : shown(text));
  const other: DevcontainerTrustValue[] = [
    ...appPort.map((port) => shown(`appPort: ${port}`)),
    ...buildOptions.map((option) => shown(`build.options: ${option}`)),
    ...(buildContext === undefined ? [] : [shown(`build.context: ${buildContext}`)]),
    ...(gpu === null ? [] : [shown(`hostRequirements.gpu: ${canonical(gpu)}`)]),
  ];
  const entries: DevcontainerTrustEntry[] = [
    { field: 'initializeCommand', values: initializeValues },
    { field: 'mounts', values: mounts.map((mount) => socketDanger(mount, mountExposesSocket(mount))) },
    { field: 'workspaceMount', values: workspaceMount ? [socketDanger(workspaceMount, mountExposesSocket(workspaceMount))] : [] },
    { field: 'runArgs', values: runArgValues(runArgs) },
    { field: 'privileged', values: privileged ? [{ text: 'true', danger: 'privileged' }] : [] },
    { field: 'capAdd', values: capAdd.map(shown) },
    { field: 'securityOpt', values: securityOpt.map(shown) },
    { field: 'features', values: features.map(([id, options]) => shown(options === true || (isRecord(options) && Object.keys(options).length === 0) ? id : `${id} ${canonical(options)}`)) },
    { field: 'otherHostAccess', values: other },
  ];
  const items = entries.filter((entry) => entry.values.length > 0);
  // The overlay refuses a longer request, so the limits fail here, where the reason can still be told.
  const count = items.reduce((sum, entry) => sum + entry.values.length, 0);
  if (count > MAX_DEVCONTAINER_TRUST_VALUES) throw new DevcontainerTrustError('tooLarge', `the configuration lists ${count} values, more than ${MAX_DEVCONTAINER_TRUST_VALUES}`);
  const long = items.find((entry) => entry.values.some((value) => value.text.length > MAX_DEVCONTAINER_TRUST_TEXT));
  if (long) throw new DevcontainerTrustError('tooLarge', `a ${long.field} value is longer than ${MAX_DEVCONTAINER_TRUST_TEXT} characters`);
  return { items, hash };
}

export interface DevcontainerTrustGateDeps {
  // the attempt's or the operation's; once it aborted nothing more is read, asked or stored
  readonly signal: AbortSignal;
  // a user watches the attempt now; nothing is asked otherwise
  mayAsk(): boolean;
  // whether the folder holding the configuration is trusted where the CLI runs, asking when it is not
  requestFolderTrust(): Promise<boolean>;
  // `devcontainer read-configuration`, which pulls images and downloads Features, so only for a trusted folder; the signal kills it
  readConfiguration(signal: AbortSignal): Promise<unknown>;
  // the hash confirmed for this container key, undefined before the first confirmation
  storedHash(): string | undefined;
  // the trust dialog, withdrawn when the signal aborts; true only on an explicit accept
  confirm(items: DevcontainerTrustItems, context: { readonly changed: boolean }, signal: AbortSignal): Promise<boolean>;
  storeHash(hash: string): Promise<void>;
}

// cancelled: the signal aborted; needsUser: it would ask, and nobody watches
export type DevcontainerTrustVerdict = 'proceed' | 'folderUntrusted' | 'configRefused' | 'cancelled' | 'needsUser';

/** Folder trust, then the resolved configuration, then the confirmation unless its hash is the one already confirmed. */
export async function runDevcontainerTrustGate(deps: DevcontainerTrustGateDeps): Promise<DevcontainerTrustVerdict> {
  const { signal } = deps;
  if (signal.aborted) return 'cancelled';
  if (!deps.mayAsk()) return 'needsUser';
  const trusted = await deps.requestFolderTrust();
  if (signal.aborted) return 'cancelled';
  if (!trusted) return 'folderUntrusted';
  let resolved: unknown;
  try {
    resolved = await deps.readConfiguration(signal);
  } catch (err) {
    // the abort killed it, whatever it failed with
    if (signal.aborted) return 'cancelled';
    throw err;
  }
  if (signal.aborted) return 'cancelled';
  const trust = devcontainerTrustFrom(resolved);
  const stored = deps.storedHash();
  if (stored === trust.hash) return 'proceed';
  if (!deps.mayAsk()) return 'needsUser';
  const accepted = await deps.confirm(trust.items, { changed: stored !== undefined }, signal);
  if (signal.aborted) return 'cancelled';
  if (!accepted) return 'configRefused';
  await deps.storeHash(trust.hash);
  return 'proceed';
}
