import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LINUX_ICON_SIZES, LINUX_ICONS_FOLDER } from '../linux-icons.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const folder = join(repoRoot, LINUX_ICONS_FOLDER);

// electron-builder installs each <n>x<n>.png the folder holds, and with none it only logs and installs Electron's icon
describe('the Linux icons', () => {
  it('are the folder electron-builder.yml names', () => {
    const config = parse(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')) as { linux?: { icon?: unknown } };
    expect(config.linux?.icon).toBe(LINUX_ICONS_FOLDER);
  });

  it('hold a PNG of each size at that size, and nothing else', () => {
    expect(readdirSync(folder).sort()).toEqual(LINUX_ICON_SIZES.map((size) => `${size}x${size}.png`).sort());
    for (const size of LINUX_ICON_SIZES) {
      const png = readFileSync(join(folder, `${size}x${size}.png`));
      expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
  });
});
