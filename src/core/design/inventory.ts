// inventory.json (PD-26): the app's stack, components, screens, types, stores and actions from Inventory, and the tokens
// and breakpoints ExtractTokens found. Core validates every reference against the chat's working folder before writing.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { MAX_INVENTORY_REFS, type DesignInventoryCategoryKey, type InventoryDetails } from '../../shared/types/design';
import type { ProjectFiles } from './citations';
import { INVENTORY_FILE } from './design-paths';
import { writeJsonAtomic } from './design-state';
import { withDesignWrite } from './design-writes';

export const MAX_INVENTORY_BYTES: number = 1024 * 1024;

export interface InventoryComponent {
  readonly name: string;
  readonly path: string;
  readonly line?: number;
  readonly variants?: readonly string[];
  readonly props?: readonly string[];
}

export interface InventoryScreen {
  readonly id: string;
  readonly entry: string;
  readonly route?: string;
  readonly container?: string;
}

export interface InventoryType {
  readonly name: string;
  /** `file:line`. */
  readonly path: string;
  readonly fields: readonly string[];
}

export interface InventoryRef {
  readonly name: string;
  /** `file` or `file:line`. */
  readonly path: string;
}

export interface InventoryTokens {
  readonly source: string;
  readonly extractor: string;
  readonly count: number;
  readonly groups: Readonly<Record<string, number>>;
}

export interface InventoryBreakpoints {
  readonly source: string;
  /** Minimum width in CSS px by breakpoint name. */
  readonly values: Readonly<Record<string, number>>;
}

export interface DesignInventory {
  readonly schemaVersion: 1;
  readonly stack: string | null;
  readonly tokens: InventoryTokens | null;
  readonly breakpoints: InventoryBreakpoints | null;
  readonly components: readonly InventoryComponent[];
  readonly screens: readonly InventoryScreen[];
  readonly types: readonly InventoryType[];
  readonly stores: readonly InventoryRef[];
  readonly actions: readonly InventoryRef[];
}

/** What the model passes to Inventory. */
export interface InventoryInput {
  readonly stack: string;
  readonly components: readonly InventoryComponent[];
  readonly screens: readonly InventoryScreen[];
  readonly types: readonly InventoryType[];
  readonly stores?: readonly InventoryRef[];
  readonly actions?: readonly InventoryRef[];
}

const EMPTY: DesignInventory = { schemaVersion: 1, stack: null, tokens: null, breakpoints: null, components: [], screens: [], types: [], stores: [], actions: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The folder's inventory, or an empty one before the first write. Throws for one that does not parse. */
export async function readInventory(folder: string): Promise<DesignInventory> {
  const file = path.join(folder, INVENTORY_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['components']) || !Array.isArray(value['screens']) || !Array.isArray(value['types'])) {
    throw new Error(`${file} is not a design inventory`);
  }
  return { ...EMPTY, ...(value as Partial<DesignInventory>) } as DesignInventory;
}

/** Replaces inventory.json with what `change` makes of it, in the folder's write lane; refuses one past 1 MiB. */
export function updateInventory(folder: string, change: (current: DesignInventory) => DesignInventory): Promise<DesignInventory> {
  return withDesignWrite(folder, async () => {
    const next = change(await readInventory(folder));
    const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
    if (bytes > MAX_INVENTORY_BYTES) throw new Error(`The inventory would be ${bytes} bytes, more than the 1 MiB inventory.json may hold`);
    await writeJsonAtomic(path.join(folder, INVENTORY_FILE), next);
    return next;
  });
}

/** Every reason the input's references do not hold in the working folder: a file that exists and a line within it. */
export async function inventoryProblems(input: InventoryInput, files: ProjectFiles): Promise<string[]> {
  const checks: Promise<string | undefined>[] = [];
  for (const component of input.components) {
    checks.push(component.line !== undefined ? files.checkRef(`${component.path}:${component.line}`, true) : files.checkRef(component.path, false));
  }
  for (const screen of input.screens) checks.push(files.checkRef(screen.entry, false));
  for (const type of input.types) checks.push(files.checkRef(type.path, true));
  for (const ref of [...(input.stores ?? []), ...(input.actions ?? [])]) checks.push(files.checkRef(ref.path, false));
  const problems = (await Promise.all(checks)).filter((problem): problem is string => problem !== undefined);
  const names = new Set<string>();
  for (const component of input.components) {
    if (names.has(component.name)) problems.push(`The component ${component.name} is listed twice`);
    names.add(component.name);
  }
  const ids = new Set<string>();
  for (const screen of input.screens) {
    if (ids.has(screen.id)) problems.push(`The screen ${screen.id} is listed twice`);
    ids.add(screen.id);
  }
  return problems;
}

/** The inventory with the input's lists, keeping the tokens and breakpoints ExtractTokens wrote. */
export function mergeInventory(current: DesignInventory, input: InventoryInput): DesignInventory {
  return {
    schemaVersion: 1,
    stack: input.stack,
    tokens: current.tokens,
    breakpoints: current.breakpoints,
    components: input.components,
    screens: input.screens,
    types: input.types,
    stores: input.stores ?? [],
    actions: input.actions ?? [],
  };
}

/** The Inventory card's rows: each category's full count, and at most MAX_INVENTORY_REFS of its refs. */
export function inventoryDetails(inventory: DesignInventory, tokenNames: readonly string[]): InventoryDetails {
  const breakpoints = inventory.breakpoints ? Object.entries(inventory.breakpoints.values) : [];
  const category = (key: DesignInventoryCategoryKey, refs: readonly string[]): InventoryDetails['categories'][number] => ({ key, count: refs.length, refs: refs.slice(0, MAX_INVENTORY_REFS) });
  return {
    categories: [
      category('components', inventory.components.map((c) => (c.line !== undefined ? `${c.path}:${c.line}` : c.path))),
      category('tokens', tokenNames),
      category('breakpoints', breakpoints.map(([name, px]) => `${name} ${px}px`)),
      category('types', inventory.types.map((t) => t.path)),
      category('screens', inventory.screens.map((s) => s.entry)),
    ],
  };
}
