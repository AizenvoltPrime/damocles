import { createHash } from 'node:crypto';

export type SettingsObject = Record<string, unknown>;

/**
 * The one parser for ~/.damocles/settings.json and <folder>/.damocles/settings(.local).json: strict JSON holding an
 * object, where empty text is an empty object and a leading BOM is ignored. The desktop settings store, the settings
 * file editor, the permission rule writer and the permission rule reader all use it.
 */
export function parseSettingsText(text: string, filePath: string): SettingsObject {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return {};
  const parsed: unknown = JSON.parse(body);
  if (!isPlainObject(parsed)) throw new Error(`${filePath} does not hold a JSON object`);
  return parsed;
}

/** sha256 hex of the file's UTF-8 text; '' for a file that does not exist. */
export function settingsFileVersion(text: string | undefined): string {
  return text === undefined ? '' : createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is SettingsObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One setting's effective value from its layer values, lowest precedence first: a plain object is merged key by key,
 * recursively, into the object below it, and any other value replaces what is below, as VS Code merges configuration.
 */
export function mergeSettingValues(values: readonly unknown[]): unknown {
  let merged: unknown;
  for (const value of values) merged = isPlainObject(merged) && isPlainObject(value) ? mergeObjects(merged, value) : structuredClone(value);
  return merged;
}

// fromEntries defines own properties, so a "__proto__" key from a settings file stays data.
function mergeObjects(below: SettingsObject, above: SettingsObject): SettingsObject {
  const keys = new Set([...Object.keys(below), ...Object.keys(above)]);
  return Object.fromEntries([...keys].map((key) => {
    if (!Object.hasOwn(above, key)) return [key, structuredClone(below[key])];
    const under = Object.hasOwn(below, key) ? below[key] : undefined;
    const value = above[key];
    return [key, isPlainObject(under) && isPlainObject(value) ? mergeObjects(under, value) : structuredClone(value)];
  }));
}
