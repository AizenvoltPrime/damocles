// This computer's WSL distros from `wsl.exe --list --verbose`, which writes UTF-16LE whatever the console code page, unless
// WSL_UTF8=1 asks for UTF-8; a call whose output is decoded as UTF-16LE runs without it (wslExeEnvironment).
import { runProcess } from '../../../../core/process-launcher';
import { windowsSystemTool } from '../../../../core/system-tools';
import type { WslDistroInfo } from '../../../preload/overlay-channels';
import { isWslDistroName } from './distro-name';

// a cold WSL service starts before it answers the list
const LIST_TIMEOUT_MS = 30_000;
// Docker Desktop's own distros, which VS Code's terminal profiles hide too
const HIDDEN_PREFIX = 'docker-desktop';

export type WslListResult = { readonly ok: true; readonly distros: readonly WslDistroInfo[] } | { readonly ok: false; readonly reason: string };

export type WslListRun = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ readonly code: number | null; readonly stdout: Buffer; readonly stderr: Buffer }>;

/** One wsl.exe call that ends on its own, on this process's launcher; code null after the timeout. */
export const runWslList: WslListRun = async (file, args, env) => {
  const { exit, stdout, stderr } = await runProcess({ file, args: [...args], env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: LIST_TIMEOUT_MS });
  return { code: exit?.code ?? null, stdout, stderr };
};

/** The environment of a wsl.exe call whose own output is read: without WSL_UTF8 in any case, so it writes UTF-16LE. */
export function wslExeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'WSL_UTF8'));
}

/** The text of wsl.exe's UTF-16LE output, its byte-order mark and NULs dropped. */
export function decodeWslOutput(bytes: Buffer): string {
  return bytes.toString('utf16le').replace(/^\uFEFF/, '').replaceAll('\0', '');
}

/**
 * Whether bytes wsl.exe passed on are its own UTF-16LE message rather than the distro's UTF-8: it writes UTF-16LE without
 * WSL_UTF8, and an inbox wsl.exe ignores WSL_UTF8. ASCII in UTF-16LE carries a NUL high byte at odd offsets and UTF-8 text
 * holds no NUL, so more NULs at odd offsets than at even ones is UTF-16LE.
 */
export function isUtf16leMessage(bytes: Buffer): boolean {
  let odd = 0;
  let even = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 0) continue;
    if (at % 2 === 1) odd++;
    else even++;
  }
  return odd > even;
}

/** The text of a whole output that is the distro's UTF-8 or wsl.exe's own UTF-16LE message. */
export function decodeWslMessages(bytes: Buffer): string {
  return isUtf16leMessage(bytes) ? decodeWslOutput(bytes) : bytes.toString('utf8').replaceAll('\0', '');
}

const stateOf = (word: string): WslDistroInfo['state'] => (word === 'Running' ? 'running' : word === 'Stopped' ? 'stopped' : 'other');

/**
 * The distros a `--list --verbose` text names: `[*] NAME STATE VERSION` rows under a header row. STATE is localized and may
 * hold spaces, so NAME is the first word and VERSION the last; a row that fits no distro is skipped. docker-desktop* rows go.
 */
export function parseWslList(text: string): WslDistroInfo[] {
  const rows = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const distros: WslDistroInfo[] = [];
  for (const row of rows.slice(1)) {
    const trimmed = row.trim();
    const isDefault = trimmed.startsWith('*');
    const words = (isDefault ? trimmed.slice(1) : trimmed).trim().split(/\s+/);
    if (words.length < 3) continue;
    const distro = words[0]!;
    const version = words[words.length - 1];
    if (!isWslDistroName(distro) || (version !== '1' && version !== '2')) continue;
    if (distro.toLowerCase().startsWith(HIDDEN_PREFIX)) continue;
    distros.push({ distro, state: stateOf(words.slice(1, -1).join(' ')), version: version === '1' ? 1 : 2, isDefault });
  }
  return distros;
}

/** `wslinfo --networking-mode` in the distro, for the log only: a WSL release without wslinfo answers its error. */
export async function wslNetworkingMode(distro: string, run: WslListRun = runWslList, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!isWslDistroName(distro)) throw new RangeError('Not a WSL distro name');
  const { code, stdout } = await run(windowsSystemTool('wsl', env), ['-d', distro, '--exec', 'wslinfo', '--networking-mode'], wslExeEnvironment(env));
  return `${decodeWslMessages(stdout).trim().slice(0, 200)} (exit ${String(code)})`;
}

/** The distros wsl.exe lists; not ok, with the reason, off Windows, when it cannot start, fails or answers past its timeout. */
export async function listWslDistros(platform: NodeJS.Platform = process.platform, run: WslListRun = runWslList, env: NodeJS.ProcessEnv = process.env): Promise<WslListResult> {
  if (platform !== 'win32') return { ok: false, reason: 'notWindows' };
  let result: Awaited<ReturnType<WslListRun>>;
  try {
    result = await run(windowsSystemTool('wsl', env), ['--list', '--verbose'], wslExeEnvironment(env));
  } catch (err) {
    return { ok: false, reason: `wsl.exe did not start: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.code === null) return { ok: false, reason: 'wsl.exe --list did not answer in time' };
  // with no distro installed wsl.exe prints an explanation and exits non-zero
  if (result.code !== 0) {
    const output = [result.stdout, result.stderr].map((bytes) => decodeWslOutput(bytes).trim()).filter((text) => text !== '').join('\n');
    return { ok: false, reason: `wsl.exe --list exited with ${result.code}: ${output.slice(0, 500)}` };
  }
  return { ok: true, distros: parseWslList(decodeWslOutput(result.stdout)) };
}
