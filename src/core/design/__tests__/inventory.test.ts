import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { ProjectFiles } from '../citations';
import { MAX_INVENTORY_REFS } from '../../../shared/types/design';
import { inventoryDetails, inventoryProblems, mergeInventory, readInventory, updateInventory, type InventoryInput } from '../inventory';

const APP = path.resolve(__dirname, '../../../../e2e/fixtures/design-app');
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function designFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inventory-'));
  folders.push(folder);
  return folder;
}
const files = (): ProjectFiles => new ProjectFiles(APP, createVsCodeFileConfinement());

const INPUT: InventoryInput = {
  stack: 'Laravel 11, Inertia, Vue 3, Tailwind 4',
  components: [
    { name: 'Button', path: 'resources/js/components/ui/Button.vue', line: 2, variants: ['primary', 'secondary', 'ghost', 'danger'] },
    { name: 'Input', path: 'resources/js/components/ui/Input.vue' },
    { name: 'Badge', path: 'resources/js/components/ui/Badge.vue', variants: ['neutral', 'success', 'danger'] },
    { name: 'Table', path: 'resources/js/components/ui/Table.vue', variants: ['comfortable', 'compact'] },
  ],
  screens: [{ id: 'contacts', entry: 'resources/js/pages/Contacts/Index.vue', route: '/contacts', container: 'max-w-7xl' }],
  types: [{ name: 'Contact', path: 'types/contact.ts:1', fields: ['id', 'name', 'email', 'phone', 'status'] }],
};

describe('Inventory', () => {
  it('accepts references that hold in the working folder and keeps ExtractTokens\' tokens and breakpoints', async () => {
    expect(await inventoryProblems(INPUT, files())).toEqual([]);
    const folder = designFolder();
    await updateInventory(folder, (current) => ({ ...current, tokens: { source: 'app.css', extractor: 'damocles-css-scan', count: 2, groups: { color: 2 } }, breakpoints: { source: 'Tailwind defaults', values: { md: 768 } } }));
    const written = await updateInventory(folder, (current) => mergeInventory(current, INPUT));
    expect(written.tokens?.count).toBe(2);
    expect(written.breakpoints?.values).toEqual({ md: 768 });
    expect((await readInventory(folder)).components.map((c) => c.name)).toEqual(['Button', 'Input', 'Badge', 'Table']);
    expect(inventoryDetails(written, ['--a', '--b']).categories.map((c) => `${c.key} ${c.count}`)).toEqual(['components 4', 'tokens 2', 'breakpoints 1', 'types 1', 'screens 1']);
  });

  it('lists at most MAX_INVENTORY_REFS refs of a category in the card, and its full count', async () => {
    const written = await updateInventory(designFolder(), (current) => mergeInventory(current, INPUT));
    const tokens = Array.from({ length: MAX_INVENTORY_REFS + 50 }, (_, n) => `--token-${n}`);
    const category = inventoryDetails(written, tokens).categories.find((c) => c.key === 'tokens')!;
    expect(category.count).toBe(MAX_INVENTORY_REFS + 50);
    expect(category.refs).toEqual(tokens.slice(0, MAX_INVENTORY_REFS));
  });

  it('lists every reference that does not hold: a missing file, a line past the end, a path outside, a duplicate', async () => {
    const problems = await inventoryProblems({
      ...INPUT,
      components: [...INPUT.components, { name: 'Button', path: 'resources/js/components/ui/Missing.vue' }],
      types: [{ name: 'Contact', path: 'types/contact.ts:900', fields: [] }, { name: 'Bare', path: 'types/contact.ts', fields: [] }],
      stores: [{ name: 'contacts', path: '../outside.ts' }],
    }, files());
    expect(problems).toEqual([
      'resources/js/components/ui/Missing.vue does not exist',
      'types/contact.ts:900: types/contact.ts has only 8 lines',
      'types/contact.ts is not a file:line reference',
      expect.stringMatching(/^\.\.\/outside\.ts (does not exist|is outside the working folder)$/),
      'The component Button is listed twice',
    ]);
  });

  it('refuses an inventory past 1 MiB and leaves the file as it was', async () => {
    const folder = designFolder();
    await updateInventory(folder, (current) => mergeInventory(current, INPUT));
    const huge = { ...INPUT, components: Array.from({ length: 512 }, (_, i) => ({ name: `C${i}`, path: 'a.vue', props: Array.from({ length: 128 }, () => 'x'.repeat(30)) })) };
    await expect(updateInventory(folder, (current) => mergeInventory(current, huge))).rejects.toThrow(/more than the 1 MiB/);
    expect((await readInventory(folder)).components).toHaveLength(4);
  });
});
