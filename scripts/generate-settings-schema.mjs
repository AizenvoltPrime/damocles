import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContributedConfiguration } from '../src/core/config/contributed-configuration.ts';
import { DESKTOP_CONFIGURATION } from '../src/desktop/main/desktop-configuration.ts';
import { isEntryPoint } from './entry-point.mjs';

/**
 * JSON Schemas for the three `.damocles` settings files, consumed only by the desktop settings JSON editor.
 *
 *   node scripts/generate-settings-schema.mjs          # write src/shared/generated/settings-schema.json
 *   node scripts/generate-settings-schema.mjs --check  # exit 1 if the committed file is stale
 *
 * `user` covers ~/.damocles/settings.json; `project` covers <folder>/.damocles/settings.json and settings.local.json,
 * where user-only keys are flagged. Every top-level key the settings readers accept is listed, the desktop-only keys of
 * src/desktop/main/desktop-configuration.ts included, and any other key is flagged as unknown.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'src', 'shared', 'generated', 'settings-schema.json');

// JSON Schema keywords copied from a contributed property; each must mean the same to Monaco's JSON service.
const KEPT_KEYWORDS = new Set([
  'type', 'default', 'enum', 'enumDescriptions', 'description', 'markdownDescription',
  'minimum', 'maximum', 'items', 'properties', 'additionalProperties',
]);
// VS Code settings-editor keywords with no JSON Schema meaning for a file on disk.
const DROPPED_KEYWORDS = new Set(['scope', 'enumItemLabels', 'order']);

// Mirrors FilePermissions in src/core/permission-handler/permission-settings.ts (a test holds the two equal).
export const PERMISSION_LISTS = {
  allow: 'Tool patterns that run without asking, e.g. "Bash(npm test:*)" or "Edit".',
  deny: 'Tool patterns that are always blocked. A deny rule wins over allow and ask.',
  ask: 'Tool patterns that always ask, even when another rule would allow them.',
};

function localize(value, nls) {
  if (typeof value === 'string') {
    const match = /^%(.+)%$/.exec(value);
    if (!match) return value;
    const text = nls[match[1]];
    if (typeof text !== 'string') throw new Error(`package.nls.json has no entry for ${value}`);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => localize(item, nls));
  return value;
}

function toSchema(property, key, nls) {
  const schema = {};
  for (const [keyword, value] of Object.entries(property)) {
    if (DROPPED_KEYWORDS.has(keyword)) continue;
    if (!KEPT_KEYWORDS.has(keyword)) throw new Error(`${key}: unhandled configuration keyword "${keyword}"; add it to KEPT_KEYWORDS or DROPPED_KEYWORDS`);
    if (keyword === 'properties') {
      schema.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toSchema(sub, `${key}.${name}`, nls)]));
    } else if ((keyword === 'items' || keyword === 'additionalProperties') && typeof value === 'object' && value !== null) {
      schema[keyword] = toSchema(value, `${key}.${keyword}`, nls);
    } else {
      schema[keyword] = localize(value, nls);
    }
  }
  return schema;
}

function permissionsSchema() {
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

function userOnlySchema(key, schema) {
  const message = `${key} applies from user settings only (~/.damocles/settings.json); a project or local settings file cannot set it.`;
  return {
    not: {},
    errorMessage: message,
    doNotSuggest: true,
    description: `${message}${schema.description === undefined ? '' : `\n\n${schema.description}`}`,
  };
}

function fileSchema(properties) {
  return { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties, additionalProperties: false };
}

export function buildSettingsSchemas(manifest, nls, desktop = DESKTOP_CONFIGURATION) {
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const contributed = {};
  for (const section of sections) {
    for (const [key, property] of Object.entries(section.properties ?? {})) contributed[key] = toSchema(property, key, nls);
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

export function renderSettingsSchemas(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const nls = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8'));
  return `${JSON.stringify(buildSettingsSchemas(manifest, nls), null, 2)}\n`;
}

function readCommitted() {
  try {
    return readFileSync(OUTPUT, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function main() {
  const text = renderSettingsSchemas();
  const name = relative(ROOT, OUTPUT);
  const committed = readCommitted();
  // A Windows checkout with core.autocrlf holds the file with CRLF endings; only a content change counts.
  const upToDate = committed !== undefined && committed.replace(/\r\n/g, '\n') === text;
  if (process.argv.includes('--check')) {
    if (!upToDate) {
      console.error(`${name} is ${committed === undefined ? 'missing' : 'stale'}. Run: node scripts/generate-settings-schema.mjs`);
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
