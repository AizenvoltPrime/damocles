import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, parseContributedConfiguration } from '../src/core/config/contributed-configuration.ts';
import { DESKTOP_CONFIGURATION, type DesktopSettingProperty } from '../src/desktop/local-services/desktop-configuration.ts';
import { isEntryPoint } from './entry-point.ts';

/**
 * JSON Schemas for the three `.damocles` settings files, consumed only by the desktop settings JSON editor.
 *
 *   node scripts/generate-settings-schema.ts          # write src/shared/generated/settings-schema.json
 *   node scripts/generate-settings-schema.ts --check  # exit 1 if the committed file is stale
 *
 * `user` covers ~/.damocles/settings.json; `project` covers <folder>/.damocles/settings.json and settings.local.json,
 * where user-only keys are flagged. Every top-level key the settings readers accept is listed, the desktop-only keys of
 * src/desktop/local-services/desktop-configuration.ts included, and any other key is flagged as unknown.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'src', 'shared', 'generated', 'settings-schema.json');

// JSON Schema keywords copied from a contributed property; each must mean the same to Monaco's JSON service.
const KEPT_KEYWORDS = new Set([
  'type', 'default', 'enum', 'enumDescriptions', 'description', 'markdownDescription',
  'minimum', 'maximum', 'items', 'properties', 'additionalProperties', 'anyOf', 'required', 'pattern', 'patternErrorMessage',
]);
// VS Code settings-editor keywords with no JSON Schema meaning for a file on disk.
const DROPPED_KEYWORDS = new Set(['scope', 'enumItemLabels', 'order', 'ignoreSync']);

// Mirrors the rule lists of FilePermissions in src/core/permission-handler/permission-settings.ts (a test holds the two equal).
export const PERMISSION_LISTS = {
  allow: 'Tool patterns that run without asking, e.g. "Bash(npm test:*)" or "Edit".',
  deny: 'Tool patterns that are always blocked. A deny rule wins over allow and ask.',
  ask: 'Tool patterns that always ask, even when another rule would allow them.',
};

/** package.nls.json: the text for each `%key%` placeholder. */
export type Nls = Readonly<Record<string, unknown>>;

/** A JSON Schema, as Monaco's JSON service reads it. */
export type Schema = Record<string, unknown>;

export interface SettingsSchemas {
  readonly user: Schema;
  readonly project: Schema;
}

function localize(value: unknown, nls: Nls): unknown {
  if (typeof value === 'string') {
    const name = /^%(.+)%$/.exec(value)?.[1];
    if (name === undefined) return value;
    const text = nls[name];
    if (typeof text !== 'string') throw new Error(`package.nls.json has no entry for ${value}`);
    return text;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => localize(item, nls));
  return value;
}

function objectAt(value: unknown, key: string): object {
  if (typeof value !== 'object' || value === null) throw new Error(`${key} must be an object`);
  return value;
}

function toSchema(property: object, key: string, nls: Nls): Schema {
  const schema: Schema = {};
  const entries: [string, unknown][] = Object.entries(property);
  for (const [keyword, value] of entries) {
    if (DROPPED_KEYWORDS.has(keyword)) continue;
    if (!KEPT_KEYWORDS.has(keyword)) throw new Error(`${key}: unhandled configuration keyword "${keyword}"; add it to KEPT_KEYWORDS or DROPPED_KEYWORDS`);
    if (keyword === 'properties') {
      const properties: [string, unknown][] = Object.entries(objectAt(value, `${key}.properties`));
      schema.properties = Object.fromEntries(properties.map(([name, sub]) => [name, toSchema(objectAt(sub, `${key}.${name}`), `${key}.${name}`, nls)]));
    } else if ((keyword === 'items' || keyword === 'additionalProperties') && typeof value === 'object' && value !== null) {
      schema[keyword] = toSchema(value, `${key}.${keyword}`, nls);
    } else if (keyword === 'anyOf') {
      if (!Array.isArray(value)) throw new Error(`${key}.anyOf must be a list`);
      const subs: readonly unknown[] = value;
      schema.anyOf = subs.map((sub, index) => toSchema(objectAt(sub, `${key}.anyOf[${index}]`), `${key}.anyOf[${index}]`, nls));
    } else {
      schema[keyword] = localize(value, nls);
    }
  }
  return schema;
}

function permissionsSchema(): Schema {
  return {
    type: 'object',
    description: 'Permission rules for Damocles tools. More specific files win: local over project over user.',
    default: { allow: [], deny: [], ask: [] },
    properties: Object.fromEntries(Object.entries(PERMISSION_LISTS).map(([name, description]) => [
      name,
      { type: 'array', items: { type: 'string' }, default: [], description },
    ])),
    additionalProperties: false,
  };
}

function userOnlySchema(key: string, schema: Schema): Schema {
  const message = `${key} applies from user settings only (~/.damocles/settings.json); a project or local settings file cannot set it.`;
  return {
    not: {},
    errorMessage: message,
    doNotSuggest: true,
    description: `${message}${schema.description === undefined ? '' : `\n\n${schema.description}`}`,
  };
}

function fileSchema(properties: Readonly<Record<string, Schema>>): Schema {
  return { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties, additionalProperties: false };
}

export function buildSettingsSchemas(manifest: Manifest, nls: Nls, desktop: Readonly<Record<string, DesktopSettingProperty>> = DESKTOP_CONFIGURATION): SettingsSchemas {
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const contributed: Record<string, Schema> = {};
  for (const section of sections) {
    const properties: Readonly<Record<string, object>> = section.properties ?? {};
    for (const [key, property] of Object.entries(properties)) contributed[key] = toSchema(property, key, nls);
  }
  const userOnlyKeys = new Set(parseContributedConfiguration(manifest).userOnlyKeys);
  for (const [key, property] of Object.entries(desktop)) {
    if (Object.hasOwn(contributed, key)) throw new Error(`desktop-only key ${key} is also a package.json setting`);
    contributed[key] = toSchema(property, key, nls);
    if (property.scope === 'application') userOnlyKeys.add(key);
  }
  for (const key of userOnlyKeys) {
    if (!Object.hasOwn(contributed, key)) throw new Error(`user-only key ${key} is not a contributed setting`);
  }
  const project = Object.fromEntries(Object.entries(contributed).map(([key, schema]) => [key, userOnlyKeys.has(key) ? userOnlySchema(key, schema) : schema]));
  return {
    user: fileSchema({ ...contributed, permissions: permissionsSchema() }),
    project: fileSchema({ ...project, permissions: permissionsSchema() }),
  };
}

export function renderSettingsSchemas(root = ROOT): string {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
  const nls = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Nls;
  return `${JSON.stringify(buildSettingsSchemas(manifest, nls), null, 2)}\n`;
}

function readCommitted(): string | undefined {
  try {
    return readFileSync(OUTPUT, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function main(): void {
  const text = renderSettingsSchemas();
  const name = relative(ROOT, OUTPUT);
  const committed = readCommitted();
  // A Windows checkout with core.autocrlf holds the file with CRLF endings; only a content change counts.
  const upToDate = committed !== undefined && committed.replace(/\r\n/g, '\n') === text;
  if (process.argv.includes('--check')) {
    if (!upToDate) {
      console.error(`${name} is ${committed === undefined ? 'missing' : 'stale'}. Run: node scripts/generate-settings-schema.ts`);
      process.exit(1);
    }
    console.log(`${name} is up to date.`);
    return;
  }
  if (upToDate) {
    console.log(`${name} is up to date.`);
    return;
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, text);
  console.log(`Wrote ${name}`);
}

if (isEntryPoint(import.meta.url)) main();
