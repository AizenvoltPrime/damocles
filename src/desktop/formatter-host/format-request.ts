import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { OUTSIDE_ROOT_CODE } from './confine-modules';
import { MAX_HOST_MESSAGE_CHARS, MAX_HOST_PATH_CHARS, type HostReply, type HostRequest } from './protocol';

type PluginOptions = { plugins?: unknown; pluginSearchDirs?: unknown };

/** The part of Prettier's API the host calls; 2.x answers format synchronously, 3.x with a promise. */
export interface PrettierApi {
  readonly version: string;
  getFileInfo(file: string, options: { resolveConfig: false; ignorePath: string | string[] } & PluginOptions): Promise<{ ignored: boolean; inferredParser: string | null }>;
  resolveConfig(file: string, options: { config: string; editorconfig: true; useCache: false }): Promise<Record<string, unknown> | null>;
  format(text: string, options: Record<string, unknown>): string | Promise<string>;
}

export interface FormatRequestDeps {
  readonly load: (entry: string) => PrettierApi;
  // the real paths the module hook has refused in this process, in order (confineModules)
  readonly refused: readonly string[];
  // the request's Prettier, config and plugins have loaded; its format budget starts
  readonly loaded: () => void;
}

// The API reads no ignore file unless named; these are the CLI's defaults, relative to the cwd, which main sets to the root.
function ignorePathOf(version: string): string | string[] {
  return version.startsWith('2.') ? '.prettierignore' : ['.gitignore', '.prettierignore'];
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_HOST_MESSAGE_CHARS);
}

function refusedPathIn(err: unknown): string | undefined {
  for (let current = err, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    const { code, path: refused } = current as Error & { code?: unknown; path?: unknown };
    if (code === OUTSIDE_ROOT_CODE && typeof refused === 'string') return refused;
  }
  return undefined;
}

// With no config file, Prettier is handed the nearest package.json above its entry, its own, which has no prettier key and
// so loads as no config: given no file, Prettier searches every folder up to the filesystem root for one.
function noConfigFile(entry: string): string {
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) || path.dirname(dir) === dir) return manifest;
  }
}

// Each parser's first format loads its plugin (the TypeScript parser is several MB): an empty text loads it before the
// format budget starts. Its outcome does not matter.
const warmed = new Set<string>();

async function warm(prettier: PrettierApi, key: string, options: Record<string, unknown>): Promise<void> {
  if (warmed.has(key)) return;
  warmed.add(key);
  try {
    await prettier.format('', options);
  } catch {
    // the real format reports any failure
  }
}

/** Formats one request with the project's Prettier and exactly the config main vetted. Never rejects. */
export async function formatRequest({ id, prettier: entry, config, file, text }: HostRequest, deps: FormatRequestDeps): Promise<HostReply> {
  const refusedBefore = deps.refused.length;
  try {
    const prettier = deps.load(entry);
    // The host outlives config edits, and nothing restarts it when .prettierrc or .editorconfig change.
    const resolved = await prettier.resolveConfig(file, { config: config ?? noConfigFile(entry), editorconfig: true, useCache: false });
    const { plugins, pluginSearchDirs } = (resolved ?? {}) as PluginOptions;
    const pluginOptions: PluginOptions = { ...(plugins !== undefined ? { plugins } : {}), ...(pluginSearchDirs !== undefined ? { pluginSearchDirs } : {}) };
    const info = await prettier.getFileInfo(file, { resolveConfig: false, ignorePath: ignorePathOf(prettier.version), ...pluginOptions });
    if (info.ignored || info.inferredParser === null) return { id, kind: 'ignored' };
    const options = { ...resolved, filepath: file };
    await warm(prettier, `${entry}\n${info.inferredParser}`, options);
    deps.loaded();
    const formatted = await prettier.format(text, options);
    if (typeof formatted !== 'string') return { id, kind: 'error', message: 'Prettier returned no text.' };
    return { id, kind: 'formatted', text: formatted };
  } catch (err) {
    // Prettier may wrap or swallow the hook's error; a refusal during this request explains the failure either way.
    const refused = refusedPathIn(err) ?? deps.refused[refusedBefore];
    return refused !== undefined ? { id, kind: 'refused', path: refused.slice(0, MAX_HOST_PATH_CHARS) } : { id, kind: 'error', message: errorText(err) };
  }
}
