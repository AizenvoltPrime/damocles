// Stage 1's text for one connect: the script with its parameter block replaced by quoted literals only.
import { ATTACH_DEADLINE_MS } from '../../../daemon/lock-timing';
import { AUTH_TIMEOUT_MS, isVersionText } from '../../../../remote/handshake';
import { releaseAssetUrl } from '../artifact-cache';
import { CONTAINER_DATA_FOLDER } from '../../../daemon/container-commands';
import type { ServerManifest, ServerTarget } from '../server-manifest-format';
import { psQuote, shellQuote } from './quote';
import POSIX_STAGE1 from './stage1-posix.sh';
import WINDOWS_STAGE1 from './stage1-windows.ps1';

export type InstallFolderCheck =
  | { readonly ok: true; readonly folder: string }
  | { readonly ok: false; readonly reason: 'empty' | 'relative' | 'newline' | 'nul' | 'controlChars' };

// every control and format character (the bidi controls among them) and the line and paragraph separators, as probe-parse.ts
// refuses them in the probe's install folder; they also reach the host card
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * An install folder setting: an absolute path on the target, POSIX or Windows, where a leading `~` means the target's home.
 * The one rule the host store and stage 1 both apply.
 */
export function validateInstallFolder(folder: string): InstallFolderCheck {
  if (folder === '') return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(folder)) return { ok: false, reason: 'newline' };
  if (folder.includes('\0')) return { ok: false, reason: 'nul' };
  if (UNSAFE.test(folder)) return { ok: false, reason: 'controlChars' };
  const absolute = folder.startsWith('/') || folder === '~' || /^~[/\\]/.test(folder) || /^[A-Za-z]:[/\\]/.test(folder);
  return absolute ? { ok: true, folder } : { ok: false, reason: 'relative' };
}

export interface StageParameters {
  readonly manifest: ServerManifest;
  // the release base; an asset is <releasesUrl>/download/v<version>/<file>; absent: the stage never downloads
  readonly releasesUrl?: string;
  // absent: the default ~/.damocles/server
  readonly installFolder?: string;
  // null: the default folder; absent: nothing to clean
  readonly previousInstallFolder?: string | null;
  // WSL only: the Windows folder of the app's cache that holds the packages, which the stage copies from through wslpath
  readonly wslCacheFolder?: string;
  // a container only: the private folder the stage makes, the app copies the package into, and the stage copies it from
  readonly containerCacheFolder?: string;
  // a devcontainer only: the data volume's folder, which ~/.damocles links to when the home has none
  readonly containerDataFolder?: string;
}

// /tmp/damocles-cache-<hex>: a fresh name per connect, created by the stage itself
const CONTAINER_CACHE = /^\/tmp\/damocles-cache-[0-9a-f]{16,64}$/;

function containerDataFolder(params: StageParameters): string {
  const folder = params.containerDataFolder;
  if (folder === undefined) return '';
  if (folder !== CONTAINER_DATA_FOLDER) throw new RangeError('a container data folder other than the data volume one');
  return folder;
}

function containerCacheFolder(params: StageParameters): string {
  const folder = params.containerCacheFolder;
  if (folder === undefined) return '';
  if (!CONTAINER_CACHE.test(folder)) throw new RangeError('a container cache folder that is not /tmp/damocles-cache-<hex>');
  if (params.wslCacheFolder !== undefined) throw new RangeError('a stage copies from one cache');
  return folder;
}

const POSIX_TARGETS = ['linux-x64', 'linux-arm64', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64'] as const satisfies readonly ServerTarget[];
const WINDOWS_TARGETS = ['win32-x64', 'win32-arm64'] as const satisfies readonly ServerTarget[];
const PARAMETERS = /# BEGIN PARAMETERS\r?\n[\s\S]*?# END PARAMETERS/;

// <file> <sha256> <size> <server version> <url|->: the manifest's checked file name and hash hold no space, the server version
// keeps to the handshake's alphabet, which names the install folder, and the URL is encoded; `-` asks for the upload at once.
function packageField(params: StageParameters, target: ServerTarget): string {
  const pkg = params.manifest.packages[target];
  if (!pkg) return '';
  if (!isVersionText(pkg.serverVersion)) throw new RangeError('a server version outside the handshake\'s version alphabet');
  const url = params.releasesUrl === undefined ? '-' : releaseAssetUrl(params.releasesUrl, params.manifest.version, pkg.file);
  return `${pkg.file} ${pkg.sha256} ${pkg.size} ${pkg.serverVersion} ${url}`;
}

function folders(params: StageParameters): { install: string; previousKind: 'none' | 'default' | 'folder'; previous: string } {
  for (const folder of [params.installFolder, params.previousInstallFolder]) {
    if (typeof folder === 'string' && !validateInstallFolder(folder).ok) throw new RangeError('an install folder that is not an absolute path on one line');
  }
  const previous = params.previousInstallFolder;
  return {
    install: params.installFolder ?? '',
    previousKind: previous === undefined ? 'none' : previous === null ? 'default' : 'folder',
    previous: previous ?? '',
  };
}

const WSL_MAPPABLE = /^[A-Za-z]:\\[^\0\r\n]*$/;

/** A drive-letter path on one line, which wslpath -u maps; a UNC path (a network --user-data-dir, a redirected profile) is not. */
export const isWslMappableFolder = (folder: string): boolean => WSL_MAPPABLE.test(folder);

function wslCacheFolder(params: StageParameters): string {
  const folder = params.wslCacheFolder;
  if (folder === undefined) return '';
  if (!isWslMappableFolder(folder)) throw new RangeError('a WSL cache folder that is not a drive path on one line');
  return folder;
}

function withParameters(template: string, block: string): string {
  if (!PARAMETERS.test(template)) throw new Error('the stage 1 template has no parameter block');
  return template.replace(PARAMETERS, () => `# BEGIN PARAMETERS\n${block}\n# END PARAMETERS`);
}

export function buildPosixStage1(params: StageParameters, template: string = POSIX_STAGE1): string {
  const { install, previousKind, previous } = folders(params);
  const lines = [
    `D_INSTALL_FOLDER=${shellQuote(install)}`,
    `D_PREVIOUS_KIND=${shellQuote(previousKind)}`,
    `D_PREVIOUS_FOLDER=${shellQuote(previous)}`,
    `D_WSL_CACHE=${shellQuote(wslCacheFolder(params))}`,
    `D_CONTAINER_CACHE=${shellQuote(containerCacheFolder(params))}`,
    `D_DATA_FOLDER=${shellQuote(containerDataFolder(params))}`,
    ...POSIX_TARGETS.map((target) => `D_${target.replace('-', '_').toUpperCase()}=${shellQuote(packageField(params, target))}`),
  ];
  return withParameters(template, lines.join('\n'));
}

export function buildWindowsStage1(params: StageParameters, template: string = WINDOWS_STAGE1): string {
  const { install, previousKind, previous } = folders(params);
  const lines = [
    `$D_INSTALL_FOLDER = ${psQuote(install)}`,
    `$D_PREVIOUS_KIND = ${psQuote(previousKind)}`,
    `$D_PREVIOUS_FOLDER = ${psQuote(previous)}`,
    ...WINDOWS_TARGETS.map((target) => `$D_${target.replace('-', '_').toUpperCase()} = ${psQuote(packageField(params, target))}`),
    // stage 1 is the Windows bridge, so it waits as attach.ts does
    `$D_ATTACH_DEADLINE_MS = ${ATTACH_DEADLINE_MS}`,
    `$D_AUTH_TIMEOUT_MS = ${AUTH_TIMEOUT_MS}`,
  ];
  return withParameters(template, lines.join('\n'));
}

// The part of a stage script above its main body: parameters and function definitions only, which tests source.
export function stageDefinitions(template: string): string {
  const at = template.indexOf('# BEGIN MAIN');
  if (at < 0) throw new Error('the stage template has no main marker');
  return template.slice(0, at);
}
