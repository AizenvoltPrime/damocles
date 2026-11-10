import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest, updateManifest } from '../design-files';
import { withDesignWrite } from '../design-writes';
import { readInventory, updateInventory } from '../inventory';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-writes-'));
  folders.push(folder);
  return folder;
}

describe('design write lanes (D65)', () => {
  it('lands all of 20 concurrent manifest updates, each reading what the last wrote (acceptance)', async () => {
    const folder = tempFolder();
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateManifest(folder, 'contacts-abcd1234', (current) => ({
      ...current,
      screens: [...current.screens, { id: `S${i}`, file: `screens/S${i}.html`, contentHash: 'h', check: { errors: 0, warnings: [] } }],
    }))));
    expect((await readManifest(folder, 'contacts-abcd1234')).screens.map((screen) => screen.id).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `S${i}`).sort());
  });

  it('runs one folder\'s writes in call order, whatever the spelling of its path, and lets a failure pass to the next', async () => {
    const folder = tempFolder();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withDesignWrite(folder, async () => {
      await held;
      order.push('first');
    });
    const failing = withDesignWrite(`${folder}${path.sep}.`, async () => {
      order.push('failing');
      throw new Error('EPERM');
    });
    const last = withDesignWrite(process.platform === 'win32' ? folder.toUpperCase() : folder, async () => {
      order.push('last');
      return 'done';
    });
    release();
    await first;
    await expect(failing).rejects.toThrow('EPERM');
    expect(await last).toBe('done');
    expect(order).toEqual(['first', 'failing', 'last']);
  });

  it('serializes the inventory and the manifest of one folder in one lane', async () => {
    const folder = tempFolder();
    const order: string[] = [];
    await Promise.all([
      updateInventory(folder, (current) => {
        order.push('inventory');
        return { ...current, stack: 'Vue' };
      }),
      updateManifest(folder, 'contacts-abcd1234', (current) => {
        order.push('manifest');
        return current;
      }),
    ]);
    expect(order).toEqual(['inventory', 'manifest']);
    expect((await readInventory(folder)).stack).toBe('Vue');
  });
});
