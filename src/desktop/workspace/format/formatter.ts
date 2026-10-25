import { promises as fs } from 'node:fs';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { HostRequest } from '../../formatter-host/protocol';
import { isInsideRealRoot } from '../../local-services/confine';
import type { HostStarters } from '../host-starters';
import { FormatterHosts, PRETTIER_INSTALL_GLOB, type HostOutcome, type HostRoot } from './formatter-hosts';
import { isPrettierConfigured, nearestPrettierConfig, resolvePrettier, supportedMajor } from './prettier-resolve';

// What format on save may run for a file: the project's own Prettier with the one config the host loads, or why not.
export type FormatResolution =
  // the file is gone: a save recreates it unformatted
  | { readonly kind: 'missing' }
  | { readonly kind: 'outsideRoot' }
  // an untrusted project, listed on its own, holds the file
  | { readonly kind: 'nestedUntrusted'; readonly fsPath: string }
  | { readonly kind: 'prettierOutside'; readonly packageDir: string }
  | { readonly kind: 'unsupported'; readonly version: string }
  | { readonly kind: 'configOutside'; readonly path: string }
  | { readonly kind: 'prettier'; readonly root: HostRoot['root']; readonly file: string; readonly entry: string; readonly version: string; readonly config: string | null }
  | { readonly kind: 'notInstalled' }
  | { readonly kind: 'none' };

export interface Formatter {
  // root: the project folder; untrusted: the other listed projects' folders that are not trusted
  resolve(root: string, file: string, untrusted: readonly string[]): Promise<FormatResolution>;
  format(target: HostRoot, request: Omit<HostRequest, 'id'>): Promise<HostOutcome>;
  // stops the host of every project not in projectKeys
  retain(projectKeys: readonly string[]): void;
  // stops the project's host and settles once its process exited
  release(projectKey: string): Promise<void>;
  running(projectKey: string): Promise<boolean>;
  dispose(): void;
}

export interface FormatterDeps {
  readonly starters: Pick<HostStarters, 'startFormatterHost'>;
  readonly watchers: FileWatcherFactory;
  readonly log: (line: string) => void;
}

async function realpathOrMissing(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Prettier's resolution and a formatter host per root, started through the starters and killed after 5 idle minutes. */
export function createFormatter(deps: FormatterDeps): Formatter {
  const hosts = new FormatterHosts({
    spawn: (root) => deps.starters.startFormatterHost(root),
    watch: (root, onChange) => {
      const watcher = deps.watchers.watch(root, PRETTIER_INSTALL_GLOB);
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      return watcher;
    },
    log: deps.log,
  });
  return {
    async resolve(root, file, untrusted) {
      const realRoot = await fs.realpath(root);
      // A file deleted under its editor has no folder to resolve from.
      const realFile = await realpathOrMissing(file);
      if (realFile === undefined) return { kind: 'missing' };
      if (!isInsideRealRoot(realRoot, realFile)) return { kind: 'outsideRoot' };
      // Trust is per folder; an untrusted folder around this project is no concern: its files outside the root never reach the host.
      for (const other of untrusted) {
        const realOther = await realpathOrMissing(other);
        if (realOther !== undefined && isInsideRealRoot(realRoot, realOther) && isInsideRealRoot(realOther, realFile)) return { kind: 'nestedUntrusted', fsPath: other };
      }
      const resolved = await resolvePrettier(realRoot, realFile);
      if (resolved.kind === 'outside') return { kind: 'prettierOutside', packageDir: resolved.packageDir };
      if (resolved.kind === 'inside') {
        const major = supportedMajor(resolved.version);
        if (major === undefined) return { kind: 'unsupported', version: resolved.version };
        // A config past the root, or the plugins it names, is code the user never trusted; the host loads only this one.
        const config = await nearestPrettierConfig(realRoot, realFile, major);
        if (config && !config.inside) return { kind: 'configOutside', path: config.path };
        return { kind: 'prettier', root: realRoot, file: realFile, entry: resolved.entry, version: resolved.version, config: config?.path ?? null };
      }
      return (await isPrettierConfigured(realRoot, realFile)) ? { kind: 'notInstalled' } : { kind: 'none' };
    },
    format: (target, request) => hosts.format(target, request),
    retain: (projectKeys) => hosts.retain(projectKeys),
    release: (projectKey) => hosts.release(projectKey),
    running: async (projectKey) => hosts.running(projectKey),
    dispose: () => hosts.dispose(),
  };
}
