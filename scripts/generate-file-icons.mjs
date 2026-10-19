import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest } from 'material-icon-theme';
import { isEntryPoint } from './entry-point.mjs';

/**
 * The desktop shell's Material file icon associations, from the material-icon-theme package's VS Code icon theme manifest.
 *
 *   node scripts/generate-file-icons.mjs          # write src/desktop/shell/generated/file-icons.json
 *   node scripts/generate-file-icons.mjs --check  # exit 1 if the committed file is stale
 *
 * Values are SVG file names under node_modules/material-icon-theme/icons/ without `.svg`; vite.shell.config.ts emits each
 * one. Keys are lowercased, as VS Code matches them. `light` holds only the light theme's overrides. `languageIds` is
 * dropped: it needs VS Code's language detection, which the shell does not have.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'src', 'desktop', 'shell', 'generated', 'file-icons.json');
const PACKAGE = join(ROOT, 'node_modules', 'material-icon-theme');
const ICON_PATH = /^\.\/\.\.\/icons\/([a-z0-9._-]+)\.svg$/;

export function renderFileIconTable() {
  const manifest = generateManifest();
  const stemOf = (id) => {
    const iconPath = manifest.iconDefinitions[id]?.iconPath;
    const match = iconPath === undefined ? null : ICON_PATH.exec(iconPath);
    if (!match) throw new Error(`icon ${id} has no file under icons/: ${iconPath}`);
    if (!existsSync(join(PACKAGE, 'icons', `${match[1]}.svg`))) throw new Error(`icons/${match[1]}.svg is missing`);
    return match[1];
  };
  const names = (record, section) => {
    const out = new Map();
    for (const [key, id] of Object.entries(record)) {
      // materialIconName matches `name` or `parent/name`; a deeper key could never match.
      if (key.split('/').length > 2) throw new Error(`${section}: ${key} names more than one parent folder`);
      const lower = key.toLowerCase();
      const stem = stemOf(id);
      if (out.has(lower) && out.get(lower) !== stem) throw new Error(`${section}: ${key} maps to both ${out.get(lower)} and ${stem}`);
      out.set(lower, stem);
    }
    return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  // Every closed folder icon has exactly one open counterpart; the generator fails otherwise.
  const openFolders = new Map([[stemOf(manifest.folder), stemOf(manifest.folderExpanded)]]);
  const pairFolders = (associations) => {
    for (const [name, id] of Object.entries(associations.folderNames)) {
      const expanded = associations.folderNamesExpanded[name];
      if (expanded === undefined) throw new Error(`folder ${name} has no expanded icon`);
      const closed = stemOf(id);
      const open = stemOf(expanded);
      if (openFolders.has(closed) && openFolders.get(closed) !== open) throw new Error(`folder icon ${closed} opens as both ${openFolders.get(closed)} and ${open}`);
      openFolders.set(closed, open);
    }
  };
  pairFolders(manifest);
  pairFolders(manifest.light);
  const associations = (source, section) => ({
    fileNames: names(source.fileNames, `${section}.fileNames`),
    fileExtensions: names(source.fileExtensions, `${section}.fileExtensions`),
    folderNames: names(source.folderNames, `${section}.folderNames`),
  });
  const version = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).version;
  const table = {
    version,
    file: stemOf(manifest.file),
    folder: stemOf(manifest.folder),
    base: associations(manifest, 'base'),
    light: associations(manifest.light, 'light'),
    openFolders: Object.fromEntries([...openFolders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  return `${JSON.stringify(table, null, 2)}\n`;
}

function main() {
  const text = renderFileIconTable();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
      console.error(`${relative(ROOT, OUTPUT)} is stale; run npm run generate:file-icons`);
      process.exit(1);
    }
    return;
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${relative(ROOT, OUTPUT)} from ${relative(ROOT, PACKAGE)}`);
}

if (isEntryPoint(import.meta.url)) main();
