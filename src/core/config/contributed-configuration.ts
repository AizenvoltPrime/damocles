// scripts/generate-settings-schema.ts imports this file through Node's type stripping: erasable TypeScript and node: imports only.

export type SettingType = string | readonly string[];

interface PropertySchema {
  readonly default?: unknown;
  readonly scope?: string;
  readonly type?: SettingType;
}

export interface Manifest {
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
  // application scoped keys and the voice keys (voice runs on the client), which a daemon's core never reads from a file
  // of its host nor writes there
  readonly clientOnlyKeys: ReadonlySet<string>;
  // resource scoped keys, read per chat folder
  readonly resourceKeys: ReadonlySet<string>;
  // A machine scoped key is read on the machine whose code uses it, as VS Code reads one on the remote side: these
  // configure code that runs on the client (voice), so a daemon's core reads them from no layer.
  readonly clientMachineKeys: ReadonlySet<string>;
  // every other machine scoped key: a daemon's core reads it only from its host's file, never from a client's user layer
  readonly hostKeys: ReadonlySet<string>;
  // each key's declared JSON type, which a value read from a settings file must have (settingTypeFits)
  readonly types: ReadonlyMap<string, SettingType>;
}

const USER_ONLY_SCOPES: ReadonlySet<string> = new Set(['machine', 'application']);
const VOICE_PREFIX = 'damocles.voice.';

export function parseContributedConfiguration(manifest: Manifest): ContributedConfiguration {
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const keys: string[] = [];
  const defaults = new Map<string, unknown>();
  const userOnlyKeys = new Set<string>(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []);
  const clientOnlyKeys = new Set<string>();
  const resourceKeys = new Set<string>();
  const clientMachineKeys = new Set<string>();
  const hostKeys = new Set<string>();
  const types = new Map<string, SettingType>();
  for (const section of sections as ReadonlyArray<{ readonly properties?: Record<string, PropertySchema> }>) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      keys.push(key);
      if (Object.hasOwn(schema, 'default')) defaults.set(key, schema.default);
      if (schema.type !== undefined) types.set(key, schema.type);
      if (schema.scope === 'resource') resourceKeys.add(key);
      if (schema.scope !== undefined && USER_ONLY_SCOPES.has(schema.scope)) userOnlyKeys.add(key);
      if (schema.scope === 'application' || key.startsWith(VOICE_PREFIX)) clientOnlyKeys.add(key);
      if (schema.scope === 'machine') (key.startsWith(VOICE_PREFIX) ? clientMachineKeys : hostKeys).add(key);
    }
  }
  return { keys, defaults, userOnlyKeys, clientOnlyKeys, resourceKeys, clientMachineKeys, hostKeys, types };
}

/**
 * Whether value has one of the JSON Schema types a setting declares. Enums are left to each reader, since the migrations
 * read stored values no longer in an enum (a retired model id).
 */
export function settingTypeFits(type: SettingType, value: unknown): boolean {
  return (typeof type === 'string' ? [type] : type).some((one) => {
    switch (one) {
      case 'boolean': return typeof value === 'boolean';
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'integer': return Number.isInteger(value);
      case 'null': return value === null;
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      default: return true;
    }
  });
}
