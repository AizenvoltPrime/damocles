import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntryPoint } from './entry-point.mjs';

// Test-only: points an INSTALLED test copy of the desktop app at a loopback update feed by rewriting its
// resources/app-update.yml, which sits outside app.asar. The app itself has no feed override of any kind.

const USAGE = `Usage: node scripts/desktop-update-override.mjs --install-dir <dir> --url http://127.0.0.1:<port>/

<dir> is the installed test app: the folder holding Damocles.exe (Windows) or damocles (Linux), or
Damocles.app (macOS). There is no default; the caller names the test install explicitly.
The existing app-update.yml must be the GitHub one electron-builder wrote; it is replaced with a generic
provider on the loopback URL, keeping updaterCacheDirName and channel.`;

const LOOPBACK_FEED = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/;
const FLAT_LINE = /^([A-Za-z][A-Za-z0-9]*): ?(.*)$/;
const KEPT_KEYS = ['updaterCacheDirName', 'channel'];

export function appUpdateYmlPath(installDir) {
  const macResources = join(installDir, 'Contents', 'Resources');
  return join(existsSync(macResources) ? macResources : join(installDir, 'resources'), 'app-update.yml');
}

// electron-builder writes app-update.yml as flat `key: value` lines; anything else fails loudly.
export function parseFlatYaml(text) {
  const entries = {};
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const match = FLAT_LINE.exec(raw);
    if (!match) throw new Error(`Unexpected app-update.yml line: ${JSON.stringify(raw)}`);
    entries[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return entries;
}

export function overrideYaml(original, url) {
  const match = LOOPBACK_FEED.exec(url);
  if (!match || Number(match[1]) > 65535) throw new Error(`The feed URL must be http://127.0.0.1:<port>/, got ${url}`);
  const current = parseFlatYaml(original);
  if (current.provider !== 'github') throw new Error(`Refusing to override app-update.yml with provider ${JSON.stringify(current.provider)}; expected the packaged github provider`);
  if (!current.updaterCacheDirName) throw new Error('app-update.yml has no updaterCacheDirName');
  const lines = ['provider: generic', `url: ${url}`];
  for (const key of KEPT_KEYS) {
    if (current[key] !== undefined) lines.push(`${key}: ${current[key]}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeOverride(installDir, url) {
  const file = appUpdateYmlPath(resolve(installDir));
  if (!existsSync(file)) throw new Error(`${file} does not exist; --install-dir must be an installed packaged app`);
  const next = overrideYaml(readFileSync(file, 'utf8'), url);
  writeFileSync(file, next);
  return { file, content: next };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === '--install-dir') options.installDir = value;
    else if (arg === '--url') options.url = value;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.installDir === undefined || options.url === undefined) throw new Error('--install-dir and --url are required');
  return options;
}

if (isEntryPoint(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
  } else {
    const { file, content } = writeOverride(options.installDir, options.url);
    console.log(`wrote ${file}:\n${content}`);
  }
}
