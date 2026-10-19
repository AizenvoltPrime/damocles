import table from './generated/file-icons.json';
import type { ThemeKind } from '../preload/panel-channels';

// vite.shell.config.ts emits each icon to dist/desktop-shell/<MATERIAL_ICON_DIR>/<icon>.svg, which the app protocol serves.
export const MATERIAL_ICON_DIR = 'file-icons';
const ICON_BASE_URL = `app://damocles/desktop-shell/${MATERIAL_ICON_DIR}/`;

type Section = 'fileNames' | 'fileExtensions' | 'folderNames';
type Associations = Readonly<Record<Section, ReadonlyMap<string, string>>>;

// Maps, so a name such as constructor or __proto__ finds nothing.
const associations = (source: Readonly<Record<Section, Readonly<Record<string, string>>>>): Associations => ({
  fileNames: new Map(Object.entries(source.fileNames)),
  fileExtensions: new Map(Object.entries(source.fileExtensions)),
  folderNames: new Map(Object.entries(source.folderNames)),
});

const BASE = associations(table.base);
const LIGHT = associations(table.light);
const OPEN_FOLDERS: ReadonlyMap<string, string> = new Map(Object.entries(table.openFolders));

/** Every icon the table can resolve to, for the build to emit. */
export function materialIconNames(): ReadonlySet<string> {
  const names = new Set([table.file, table.folder, ...OPEN_FOLDERS.values()]);
  for (const source of [BASE, LIGHT]) for (const map of Object.values(source)) for (const name of map.values()) names.add(name);
  return names;
}

/**
 * The Material icon of a file or folder, resolved as VS Code resolves an icon theme: `parent/name`, then the name, then for a
 * file each extension from the longest (`d.ts` before `ts`). The light theme's overrides win at each step.
 */
export function materialIconName(path: string, directory: boolean, open: boolean, kind: ThemeKind): string {
  const segments = path.toLowerCase().split(/[\\/]/).filter((segment) => segment !== '');
  const name = segments.at(-1) ?? '';
  const parent = segments.at(-2);
  const find = (section: Section, key: string): string | undefined => (kind === 'light' ? LIGHT[section].get(key) : undefined) ?? BASE[section].get(key);
  const named = (section: Section): string | undefined => (parent === undefined ? undefined : find(section, `${parent}/${name}`)) ?? find(section, name);
  if (directory) {
    const closed = named('folderNames') ?? table.folder;
    return open ? OPEN_FOLDERS.get(closed) ?? closed : closed;
  }
  const byName = named('fileNames');
  if (byName !== undefined) return byName;
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const byExtension = find('fileExtensions', name.slice(dot + 1));
    if (byExtension !== undefined) return byExtension;
  }
  return table.file;
}

export function materialIconUrl(name: string): string {
  return `${ICON_BASE_URL}${name}.svg`;
}
