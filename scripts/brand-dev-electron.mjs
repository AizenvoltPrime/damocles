// Writes a copy of the dev Electron runtime whose binary has Damocles' icon and name, as electron-builder brands Damocles.exe.
// Electron's notification support creates a Start Menu shortcut to the running binary under the app's AppUserModelID, and
// Windows takes the taskbar icon and name for that ID from the shortcut, which shows the binary's own icon and product name.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PRODUCT_NAME, devElectronDist } from './dev-electron-binary.mjs';

// Windows picks the entry nearest the displayed size, from 16 px at 100% scaling to 256 px for large icons.
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const STAMP = 'damocles-brand.json';
const scriptPath = fileURLToPath(import.meta.url);
const iconPng = join(dirname(scriptPath), '..', 'resources', 'icon.png');

/** Runs inside Electron, whose nativeImage scales the PNG; writes an ICO of PNG entries to `out`. */
async function writeIco(out) {
  const { app, nativeImage } = await import('electron');
  // Otherwise Electron keeps a profile for this run in %APPDATA%\Electron.
  app.setPath('userData', join(dirname(out), 'profile'));
  await app.whenReady();
  const source = nativeImage.createFromPath(iconPng);
  const images = ICON_SIZES.map((size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  ICON_SIZES.forEach((size, i) => {
    const entry = 6 + 16 * i;
    // A width or height byte of 0 means 256.
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  writeFileSync(out, Buffer.concat([header, ...images]));
  app.quit();
}

async function brandedBinary(stock, work) {
  const ico = join(work, 'icon.ico');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const render = spawnSync(stock, [scriptPath, ico], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (render.status !== 0 || !existsSync(ico)) throw new Error(`Rendering the icon with ${stock} failed (exit ${render.status}).`);

  const ResEdit = await import('resedit');
  const image = ResEdit.NtExecutable.from(readFileSync(stock), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(image);
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const icons = ResEdit.Data.IconFile.from(readFileSync(ico)).icons.map((icon) => icon.data);
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
    .update(readFileSync(iconPng))
    .update(`${DEV_PRODUCT_NAME}|${ICON_SIZES.join()}|${source.size}|${source.mtimeMs}`)
    .digest('hex');
  if (existsSync(target) && existsSync(stampFile) && JSON.parse(readFileSync(stampFile, 'utf8')).key === key) return;

  const work = mkdtempSync(join(tmpdir(), 'damocles-brand-'));
  const staged = `${targetDir}.staged`;
  try {
    rmSync(staged, { recursive: true, force: true });
    cpSync(dirname(stock), staged, { recursive: true, filter: (from) => from !== stock });
    writeFileSync(join(staged, basename(stock)), await brandedBinary(stock, work));
    writeFileSync(join(staged, STAMP), JSON.stringify({ key }));
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') throw new Error(`${target} is in use; close the running dev app and try again.`);
      throw err;
    }
    renameSync(staged, targetDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
  console.log(`Wrote ${target} with Damocles' icon.`);
}

// Electron holds its ready event until an ESM entry settles, so the Electron branch must not be awaited here.
if (process.versions.electron) {
  writeIco(process.argv.at(-1)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  await brand();
}
