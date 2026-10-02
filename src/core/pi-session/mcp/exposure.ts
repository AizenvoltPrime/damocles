import type {
  McpToolExposure,
  McpToolExposureScope,
  McpToolExposureSetting,
  McpToolExposureSource,
} from '../../../shared/types/mcp';
import type { SettingInspection } from '../../../platform/settings-store';

/** pi's config values as Damocles exposes them; codemode is not offered, so both codemode values defer. */
const EXPOSURE_BY_CONFIG_VALUE: Readonly<Record<McpToolExposure, McpToolExposureSetting>> = {
  hidden: 'off',
  codemode: 'deferred',
  'codemode-deferred': 'deferred',
  deferred: 'deferred',
  direct: 'direct',
};

const SETTING_VALUES: ReadonlySet<string> = new Set<McpToolExposureSetting>(['off', 'deferred', 'direct']);

export function isToolExposureSetting(value: unknown): value is McpToolExposureSetting {
  return typeof value === 'string' && SETTING_VALUES.has(value);
}

/** An unknown value reads as deferred, the default. */
export function exposureFromConfigValue(value: unknown): McpToolExposureSetting {
  return typeof value === 'string' && Object.hasOwn(EXPOSURE_BY_CONFIG_VALUE, value)
    ? EXPOSURE_BY_CONFIG_VALUE[value as McpToolExposure]
    : 'deferred';
}

/** Knuth-Morris-Pratt search of `text[from, end)`; returns the match index or -1, in O(scanned + needle). */
function indexOfLinear(text: string, needle: string, from: number, end: number): number {
  if (needle.length === 0) return from;
  const failure = new Array<number>(needle.length).fill(0);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = failure[k - 1]!;
    if (needle[i] === needle[k]) k++;
    failure[i] = k;
  }
  for (let i = from, k = 0; i < end; i++) {
    while (k > 0 && text[i] !== needle[k]) k = failure[k - 1]!;
    if (text[i] === needle[k]) k++;
    if (k === needle.length) return i - needle.length + 1;
  }
  return -1;
}

/**
 * Whether `name` matches a `toolExposure` pattern: `*` matches any run of characters, every other
 * character matches only itself, and the match is anchored at both ends. Each literal segment is found
 * once, leftmost, so the cost is linear in the name plus the pattern whatever the pattern holds.
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const segments = pattern.split('*');
  if (segments.length === 1) return pattern === name;
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (first.length + last.length > name.length || !name.startsWith(first) || !name.endsWith(last)) return false;
  let position = first.length;
  const end = name.length - last.length;
  for (let s = 1; s < segments.length - 1; s++) {
    const segment = segments[s]!;
    const found = indexOfLinear(name, segment, position, end);
    if (found < 0) return false;
    position = found + segment.length;
  }
  return position <= end;
}

/** The config side of a server: `exposure` and `toolExposure` as `mcp.json` holds them. */
export interface McpConfigExposure {
  exposure?: McpToolExposure;
  toolExposure?: Record<string, McpToolExposure>;
}

/** A tool's exposure from its server's config: the exact key, then the first matching pattern, then the server's `exposure`. */
export function configToolExposure(config: McpConfigExposure, rawToolName: string): McpToolExposureSetting {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, rawToolName)) return exposureFromConfigValue(overrides[rawToolName]);
  for (const [pattern, value] of Object.entries(overrides)) {
    if (pattern.includes('*') && matchesToolPattern(pattern, rawToolName)) return exposureFromConfigValue(value);
  }
  return exposureFromConfigValue(config.exposure);
}

/** Whether a server's config can expose any tool directly, before its tools are known. */
export function configMayExposeDirect(config: McpConfigExposure): boolean {
  if (exposureFromConfigValue(config.exposure) === 'direct') return true;
  return Object.values(config.toolExposure ?? {}).some((value) => exposureFromConfigValue(value) === 'direct');
}

/** One scope's `damocles.mcp.toolExposure` map, lowest scope first. */
export interface ToolExposureLayer {
  scope: McpToolExposureScope;
  value: unknown;
}

/**
 * The setting's layers as `inspect()` reports them: user, then project, then local, the last two only
 * in a trusted folder. Read per layer because the host's own object merge differs between hosts.
 */
export function toolExposureLayers(inspection: SettingInspection<unknown>, trusted: boolean): ToolExposureLayer[] {
  const layers: ToolExposureLayer[] = [{ scope: 'user', value: inspection.userValue }];
  if (trusted) layers.push({ scope: 'project', value: inspection.projectValue }, { scope: 'local', value: inspection.localValue });
  return layers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A layer's entry for one tool, when it holds a valid one. */
export function layerToolExposure(value: unknown, serverName: string, rawToolName: string): McpToolExposureSetting | undefined {
  if (!isRecord(value)) return undefined;
  const tools = value[serverName];
  if (!isRecord(tools) || !Object.hasOwn(tools, rawToolName)) return undefined;
  const entry = tools[rawToolName];
  return isToolExposureSetting(entry) ? entry : undefined;
}

export interface ResolvedToolExposure {
  exposure: McpToolExposureSetting;
  source: McpToolExposureSource;
}

/** The highest layer holding an entry for the tool wins; with none, the config's value stands. */
export function resolveToolExposure(
  layers: readonly ToolExposureLayer[],
  serverName: string,
  rawToolName: string,
  configExposure: McpToolExposureSetting,
): ResolvedToolExposure {
  for (let i = layers.length - 1; i >= 0; i--) {
    const entry = layerToolExposure(layers[i]!.value, serverName, rawToolName);
    if (entry !== undefined) return { exposure: entry, source: layers[i]!.scope };
  }
  return { exposure: configExposure, source: 'config' };
}

export type ToolExposureMap = Record<string, Record<string, unknown>>;

/**
 * The `damocles.mcp.toolExposure` map to write at one scope so the tool's exposure there is `exposure`.
 * `current` is that scope's map as `inspect()` reports it, `below` the layers under that scope. When
 * `below` and the config already give `exposure`, the entry is removed rather than duplicated. Every
 * other entry is kept as found. Undefined means the scope holds no entry at all, so the key is removed.
 */
export function toolExposureMapForScope(
  current: unknown,
  below: readonly ToolExposureLayer[],
  serverName: string,
  rawToolName: string,
  exposure: McpToolExposureSetting,
  configExposure: McpToolExposureSetting,
): ToolExposureMap | undefined {
  const next: ToolExposureMap = isRecord(current) ? { ...(current as ToolExposureMap) } : {};
  const existing = Object.hasOwn(next, serverName) ? next[serverName] : undefined;
  const tools: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  if (resolveToolExposure(below, serverName, rawToolName, configExposure).exposure === exposure) delete tools[rawToolName];
  else setOwn(tools, rawToolName, exposure);
  if (Object.keys(tools).length > 0) setOwn(next, serverName, tools);
  else delete next[serverName];
  return Object.keys(next).length > 0 ? next : undefined;
}

/** An own enumerable key even for `__proto__`, which plain assignment would treat as the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Whether any layer sets one of the server's tools to `direct`. */
export function layersExposeDirect(layers: readonly ToolExposureLayer[], serverName: string): boolean {
  return layers.some(({ value }) => {
    const tools = isRecord(value) ? value[serverName] : undefined;
    return isRecord(tools) && Object.values(tools).includes('direct');
  });
}
