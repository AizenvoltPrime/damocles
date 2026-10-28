// Stage 1's text for one connect: the script with its parameter block replaced by quoted literals only.
import { releaseAssetUrl } from '../artifact-cache';
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
  // the release base; an asset is <releasesUrl>/download/v<version>/<file>
  readonly releasesUrl: string;
  // absent: the default ~/.damocles/server
  readonly installFolder?: string;
  // null: the default folder; absent: nothing to clean
  readonly previousInstallFolder?: string | null;
}

const POSIX_TARGETS = ['linux-x64', 'linux-arm64', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64'] as const satisfies readonly ServerTarget[];
const WINDOWS_TARGETS = ['win32-x64', 'win32-arm64'] as const satisfies readonly ServerTarget[];
const PARAMETERS = /# BEGIN PARAMETERS\r?\n[\s\S]*?# END PARAMETERS/;

// <file> <sha256> <size> <url>: the manifest's checked file name and hash hold no space, and the URL is encoded.
function packageField(params: StageParameters, target: ServerTarget): string {
  const pkg = params.manifest.packages[target];
  return pkg ? `${pkg.file} ${pkg.sha256} ${pkg.size} ${releaseAssetUrl(params.releasesUrl, params.manifest.version, pkg.file)}` : '';
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

function withParameters(template: string, block: string): string {
  if (!PARAMETERS.test(template)) throw new Error('the stage 1 template has no parameter block');
  return template.replace(PARAMETERS, () => `# BEGIN PARAMETERS\n${block}\n# END PARAMETERS`);
}

export function buildPosixStage1(params: StageParameters, template: string = POSIX_STAGE1): string {
  const { install, previousKind, previous } = folders(params);
  const lines = [
    `D_VERSION=${shellQuote(params.manifest.version)}`,
    `D_INSTALL_FOLDER=${shellQuote(install)}`,
    `D_PREVIOUS_KIND=${shellQuote(previousKind)}`,
    `D_PREVIOUS_FOLDER=${shellQuote(previous)}`,
    ...POSIX_TARGETS.map((target) => `D_${target.replace('-', '_').toUpperCase()}=${shellQuote(packageField(params, target))}`),
  ];
  return withParameters(template, lines.join('\n'));
}

export function buildWindowsStage1(params: StageParameters, template: string = WINDOWS_STAGE1): string {
  const { install, previousKind, previous } = folders(params);
  const lines = [
    `$D_VERSION = ${psQuote(params.manifest.version)}`,
    `$D_INSTALL_FOLDER = ${psQuote(install)}`,
    `$D_PREVIOUS_KIND = ${psQuote(previousKind)}`,
    `$D_PREVIOUS_FOLDER = ${psQuote(previous)}`,
    ...WINDOWS_TARGETS.map((target) => `$D_${target.replace('-', '_').toUpperCase()} = ${psQuote(packageField(params, target))}`),
  ];
  return withParameters(template, lines.join('\n'));
}

// The part of a stage script above its main body: parameters and function definitions only, which tests source.
export function stageDefinitions(template: string): string {
  const at = template.indexOf('# BEGIN MAIN');
  if (at < 0) throw new Error('the stage template has no main marker');
  return template.slice(0, at);
}
