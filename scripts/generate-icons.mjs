// Writes resources/icon.ico and the artwork of build/icon.icon from resources/icon.png; run after changing icon.png and
// commit the output. Windows loads the window, tray and executable icons from the ICO at the exact size each one is
// displayed at. build/icon.icon is the macOS Icon Composer icon, whose icon.json is edited by hand.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every size Windows 11 shows an app icon at, 100% to 400% scaling ("Construct your Windows app's icon" on learn.microsoft.com).
const ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(scriptPath), '..');
const iconPng = join(repoRoot, 'resources', 'icon.png');
const iconIco = join(repoRoot, 'resources', 'icon.ico');
// Icon Composer's canvas is 1024 points; icon.json places this layer on it.
const MAC_ARTWORK_SIZE = 1024;
const macArtwork = join(repoRoot, 'build', 'icon.icon', 'Assets', 'damocles.png');

/** Runs inside Electron, whose nativeImage scales the PNG with a Lanczos filter; writes an ICO of PNG entries and the macOS artwork. */
async function writeIcons(profileDir) {
  const { app, nativeImage } = await import('electron');
  // Otherwise Electron keeps a profile for this run in %APPDATA%\Electron.
  app.setPath('userData', profileDir);
  await app.whenReady();
  const source = nativeImage.createFromPath(iconPng);
  // nativeImage returns an empty image for a missing or unreadable file, and every resize of it is an empty PNG.
  if (source.isEmpty()) throw new Error(`Could not read ${iconPng} as an image.`);
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
  writeFileSync(iconIco, Buffer.concat([header, ...images]));
  mkdirSync(dirname(macArtwork), { recursive: true });
  writeFileSync(macArtwork, source.resize({ width: MAC_ARTWORK_SIZE, height: MAC_ARTWORK_SIZE, quality: 'best' }).toPNG());
  app.quit();
}

// Electron holds its ready event until an ESM entry settles, so the Electron branch must not be awaited here.
if (process.versions.electron) {
  writeIcons(process.argv.at(-1)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const profileDir = mkdtempSync(join(tmpdir(), 'damocles-icons-'));
  try {
    const render = spawnSync(electron, [scriptPath, profileDir], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (render.status !== 0) throw new Error(`Rendering the icon with ${electron} failed (exit ${render.status}).`);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
  console.log(`Wrote ${iconIco} and ${macArtwork}.`);
}
