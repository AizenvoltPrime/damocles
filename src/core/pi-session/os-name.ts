import { open } from 'fs/promises';
import * as os from 'os';
import { stripBidiControls, stripControlChars } from './untrusted-text';

/** What the product name is read from, injected so each platform's branch can be tested anywhere. */
export interface OsNameInputs {
  readonly platform: NodeJS.Platform;
  /** `os.release()`: the kernel's version, `10.0.<build>` on Windows and the Darwin version on macOS. */
  readonly release: string;
  /** `os.type()`. */
  readonly type: string;
  /** The text of the first readable os-release file, or undefined when none is. */
  readonly osRelease: string | undefined;
}

/** The first Windows build that is Windows 11. */
const WINDOWS_11_BUILD = 22000;

/** os-release fields are short; this bounds a hostile file's value before it reaches the prompt. */
const OS_RELEASE_FIELD_MAX_CHARS = 64;

/** How much of an os-release file is read; distributions ship one well under 1 KiB. */
const OS_RELEASE_MAX_BYTES = 8192;

const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'];

/**
 * The OS as a product name ("Windows 11", "macOS 15", "Ubuntu 24.04"), which changes with an OS upgrade and never with a
 * kernel or point update, since the environment section it fills is an identity section (`identity-prompt-fold.ts`).
 */
export function productOsName(inputs: OsNameInputs): string {
  switch (inputs.platform) {
    case 'win32':
      return windowsName(inputs.release);
    case 'darwin':
      return macName(inputs.release);
    case 'linux':
      return linuxName(inputs.osRelease) ?? 'Linux';
    default:
      return inputs.type;
  }
}

function windowsName(release: string): string {
  const [major, minor, build] = release.split('.');
  if (major === '10' && minor === '0' && Number(build) >= WINDOWS_11_BUILD) return 'Windows 11';
  if (major === '10' && minor === '0') return 'Windows 10';
  return `Windows ${major ?? ''}.${minor ?? ''}`;
}

/** Darwin 20 is macOS 11 and each major since is one macOS major, except Darwin 25, which Apple named macOS 26 (Tahoe). */
function macName(release: string): string {
  const darwin = Number(release.split('.')[0]);
  return `macOS ${darwin >= 25 ? darwin + 1 : darwin - 9}`;
}

/** NAME and VERSION_ID from an os-release file (`os-release(5)`), shell-quoted or not; undefined without a NAME. */
function linuxName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/s.exec(line.trim());
    if (match) fields.set(match[1]!, osReleaseValue(match[2]!));
  }
  const name = fields.get('NAME');
  if (!name) return undefined;
  const version = fields.get('VERSION_ID');
  return version ? `${name} ${version}` : name;
}

function osReleaseValue(raw: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(raw);
  const value = quoted ? (quoted[1] === '"' ? quoted[2]!.replace(/\\(["\\$`])/g, '$1') : quoted[2]!) : raw;
  return [...stripBidiControls(stripControlChars(value))].slice(0, OS_RELEASE_FIELD_MAX_CHARS).join('').trim();
}

async function readOsRelease(): Promise<string | undefined> {
  for (const file of OS_RELEASE_FILES) {
    try {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(OS_RELEASE_MAX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, OS_RELEASE_MAX_BYTES, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      // the next file, or none: an unreadable os-release names the OS "Linux"
    }
  }
  return undefined;
}

let loading: Promise<string> | undefined;
let loaded: string | undefined;

/** Reads this process's OS name once: nothing it reads changes without a reboot. */
export function loadOsName(): Promise<string> {
  loading ??= (process.platform === 'linux' ? readOsRelease() : Promise.resolve(undefined)).then((osRelease) => {
    loaded = productOsName({ platform: process.platform, release: os.release(), type: os.type(), osRelease });
    return loaded;
  });
  return loading;
}

/** The name `loadOsName` read, which a session awaits as it starts (`PiSession.start`), before anything builds its prompt. */
export function osName(): string {
  if (loaded === undefined) throw new Error('The OS name is read before a session starts.');
  return loaded;
}
