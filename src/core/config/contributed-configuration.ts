// scripts/generate-settings-schema.mjs imports this file through Node's type stripping: erasable TypeScript and node: imports only.

interface PropertySchema {
  readonly default?: unknown;
  readonly scope?: string;
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
  for (const section of sections as ReadonlyArray<{ readonly properties?: Record<string, PropertySchema> }>) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      keys.push(key);
      if (Object.hasOwn(schema, 'default')) defaults.set(key, schema.default);
      if (schema.scope === 'resource') resourceKeys.add(key);
      if (schema.scope !== undefined && USER_ONLY_SCOPES.has(schema.scope)) userOnlyKeys.add(key);
      if (schema.scope === 'application' || key.startsWith(VOICE_PREFIX)) clientOnlyKeys.add(key);
      if (schema.scope === 'machine') (key.startsWith(VOICE_PREFIX) ? clientMachineKeys : hostKeys).add(key);
    }
  }
  return { keys, defaults, userOnlyKeys, clientOnlyKeys, resourceKeys, clientMachineKeys, hostKeys };
}
