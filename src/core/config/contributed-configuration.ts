// scripts/generate-settings-schema.mjs imports this file through Node's type stripping: erasable TypeScript and node: imports only.
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PropertySchema {
  readonly default?: unknown;
  readonly scope?: string;
}

interface Manifest {
  readonly capabilities?: { readonly untrustedWorkspaces?: { readonly restrictedConfigurations?: readonly string[] } };
  readonly contributes?: {
    readonly configuration?: { readonly properties?: Record<string, PropertySchema> } | ReadonlyArray<{ readonly properties?: Record<string, PropertySchema> }>;
  };
}

export interface ContributedConfiguration {
  // every key package.json contributes, in declaration order
  readonly keys: readonly string[];
  // declared defaults, keyed by full dotted key
  readonly defaults: ReadonlyMap<string, unknown>;
  // keys a project or local file never supplies: restrictedConfigurations plus machine and application scoped keys
  readonly userOnlyKeys: ReadonlySet<string>;
}

const USER_ONLY_SCOPES: ReadonlySet<string> = new Set(['machine', 'application']);

export function parseContributedConfiguration(manifest: Manifest): ContributedConfiguration {
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const keys: string[] = [];
  const defaults = new Map<string, unknown>();
  const userOnlyKeys = new Set<string>(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []);
  for (const section of sections as ReadonlyArray<{ readonly properties?: Record<string, PropertySchema> }>) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      keys.push(key);
      if (Object.hasOwn(schema, 'default')) defaults.set(key, schema.default);
      if (schema.scope !== undefined && USER_ONLY_SCOPES.has(schema.scope)) userOnlyKeys.add(key);
    }
  }
  return { keys, defaults, userOnlyKeys };
}

const cache = new Map<string, ContributedConfiguration>();

/** The settings package.json under resourceRoot contributes; read once per root. */
export function readContributedConfiguration(resourceRoot: string): ContributedConfiguration {
  const cached = cache.get(resourceRoot);
  if (cached) return cached;
  const manifest = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'package.json'), 'utf8')) as Manifest;
  const parsed = parseContributedConfiguration(manifest);
  cache.set(resourceRoot, parsed);
  return parsed;
}
