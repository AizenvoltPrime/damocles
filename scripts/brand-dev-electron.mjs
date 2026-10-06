// Writes a copy of the dev Electron runtime whose binary has Damocles' icon and name, as electron-builder brands Damocles.exe.
// With no Start Menu shortcut carrying the app's AppUserModelID, Windows takes the name and icon of a taskbar pin, the jump
// list and Task Manager from the running binary, which for the stock electron.exe are Electron's.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PRODUCT_NAME, devElectronDist } from './dev-electron-binary.mjs';

const STAMP = 'damocles-brand.json';
// Written by scripts/generate-icons.mjs.
const iconIco = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.ico');

async function brandedBinary(stock) {
  const ResEdit = await import('resedit');
  const image = ResEdit.NtExecutable.from(readFileSync(stock), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(image);
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const icons = ResEdit.Data.IconFile.from(readFileSync(iconIco)).icons.map((icon) => icon.data);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
  const [version] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  for (const language of version.getAllLanguagesForStringValues()) {
    version.setStringValues(language, { ProductName: DEV_PRODUCT_NAME, FileDescription: DEV_PRODUCT_NAME });
  }
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(image);
  return Buffer.from(image.generate());
}

async function brand() {
  if (process.platform !== 'win32') return;
  const require = createRequire(import.meta.url);
  // The downloaded binary: the electron package's main export when no ELECTRON_OVERRIDE_DIST_PATH is set.
  const stock = require('electron');
  const targetDir = devElectronDist(dirname(require.resolve('electron/package.json')));
  const target = join(targetDir, basename(stock));
  const stampFile = join(targetDir, STAMP);
  const source = statSync(stock);
  const key = createHash('sha256')
    .update(readFileSync(iconIco))
    .update(`${DEV_PRODUCT_NAME}|${source.size}|${source.mtimeMs}`)
    .digest('hex');
  if (existsSync(target) && existsSync(stampFile) && JSON.parse(readFileSync(stampFile, 'utf8')).key === key) return;

  const staged = `${targetDir}.staged`;
  try {
    rmSync(staged, { recursive: true, force: true });
    cpSync(dirname(stock), staged, { recursive: true, filter: (from) => from !== stock });
    writeFileSync(join(staged, basename(stock)), await brandedBinary(stock));
    writeFileSync(join(staged, STAMP), JSON.stringify({ key }));
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') throw new Error(`${target} is in use; close the running dev app and try again.`);
      throw err;
    }
    renameSync(staged, targetDir);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  console.log(`Wrote ${target} with Damocles' icon.`);
}

await brand();
