// The wire's compatibility check (docs/invariants.md "Remote daemon and wire"), read from the contracts' types with the
// TypeScript compiler API:
//   node scripts/protocol-compat.mjs [--allow-breaking]  writes src/remote/protocol-snapshot.json when the change from the
//                                                        committed one is compatible; --allow-breaking only while pre-release
//   node scripts/protocol-compat.mjs --check             fails unless the committed snapshot matches the contracts
//   node scripts/protocol-compat.mjs --against <file>    fails on an incompatible change from an older snapshot (CI's base)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = join(ROOT, 'src', 'remote', 'protocol-snapshot.json');
const VERSION_FILE = join(ROOT, 'src', 'remote', 'protocol-version.ts');
// Nested types are spelled out this deep; past it a type is kept as its text.
const MAX_DEPTH = 10;

/**
 * The contracts: each interface or type alias, by the file that declares it. A table (a channel's commands, events, mirrors
 * or panel ops) may gain members; a frozen contract never changes, whatever the protocol version.
 */
export const CONTRACTS = [
  ...['CoreRequests', 'MainRequests', 'CoreEvents', 'MainEvents', 'CoreMirrorTopics', 'MirrorTopics', 'CorePanelOps', 'MainPanelOps'].map((type) => ({ file: 'src/desktop/core-protocol/messages.ts', type, table: true })),
  { file: 'src/desktop/core-protocol/messages.ts', type: 'CoreInit' },
  ...['WorkspaceRequests', 'WorkspaceClientEvents', 'WorkspaceHostEvents'].map((type) => ({ file: 'src/desktop/workspace/messages.ts', type, table: true })),
  ...['ControlRequests', 'ControlEvents'].map((type) => ({ file: 'src/desktop/daemon/control-messages.ts', type, table: true })),
  { file: 'src/desktop/daemon/control-messages.ts', type: 'FrozenControl', table: true, frozen: true },
  ...['Hello', 'Welcome', 'Refused', 'HostFacts'].map((type) => ({ file: 'src/remote/handshake.ts', type, frozen: true })),
  ...['ExtensionToWebviewMessage', 'WebviewToExtensionMessage'].map((type) => ({ file: 'src/shared/types/messages.ts', type })),
];

function compilerOptions(root) {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
  return { ...config.options, noEmit: true };
}

// The compiler prints a module it cannot name relatively as import("<absolute path>"); the snapshot keeps it relative to root.
function relativeImports(root) {
  const fold = process.platform === 'win32' ? (text) => text.toLowerCase() : (text) => text;
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  return (text) => text.replaceAll(/import\("([^"]+)"\)/g, (whole, file) => (fold(file).startsWith(fold(prefix)) ? `import("${file.slice(prefix.length)}")` : whole));
}

/** A canonical, JSON-shaped description of a type: objects by property, unions sorted, discriminated unions by tag. */
function describer(checker, root) {
  const relative = relativeImports(root);
  const describe = (type, depth, stack) => {
    const text = relative(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType));
    const flags = type.flags;
    if (flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value);
    if (flags & ts.TypeFlags.NumberLiteral) return String(type.value);
    if (flags & ts.TypeFlags.BooleanLiteral) return text;
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.ESSymbol)) return text;
    if (depth > MAX_DEPTH || stack.includes(type)) return { ref: text };
    const inner = [...stack, type];
    if (type.isUnion()) {
      const members = type.types;
      // boolean is the union true | false
      const collapsed = members.some((member) => member.flags & ts.TypeFlags.BooleanLiteral) && members.filter((member) => member.flags & ts.TypeFlags.BooleanLiteral).length === 2
        ? ['boolean', ...members.filter((member) => !(member.flags & ts.TypeFlags.BooleanLiteral)).map((member) => describe(member, depth + 1, inner))]
        : members.map((member) => describe(member, depth + 1, inner));
      const tag = discriminant(members);
      if (tag) {
        // members sharing a tag value are one variant, its shapes as a union
        const groups = new Map();
        for (const member of members) {
          const key = JSON.stringify(checker.getTypeOfSymbol(checker.getPropertyOfType(member, tag)).value);
          groups.set(key, [...(groups.get(key) ?? []), describe(member, depth + 1, inner)]);
        }
        const variants = Object.fromEntries([...groups].map(([key, shapes]) => [key, shapes.length === 1 ? shapes[0] : { union: shapes.map((shape) => JSON.stringify(shape)).sort().map((shape) => JSON.parse(shape)) }]));
        return { variants: tag, of: sortKeys(variants) };
      }
      return { union: collapsed.map((entry) => JSON.stringify(entry)).sort().map((entry) => JSON.parse(entry)) };
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type);
      return checker.isTupleType(type) ? { tuple: args.map((arg) => describe(arg, depth + 1, inner)) } : { array: describe(args[0], depth + 1, inner) };
    }
    if (type.getCallSignatures().length > 0) return 'function';
    const symbol = type.getSymbol();
    // a lib class or interface (Uint8Array, Buffer, Date, Promise) is kept by name; a lib alias (Record, Pick) is spelled out
    const library = symbol && (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) !== 0 && symbol.getDeclarations()?.some((declaration) => declaration.getSourceFile().hasNoDefaultLib || declaration.getSourceFile().fileName.includes('/node_modules/'));
    if (library) return { named: text };
    if (flags & ts.TypeFlags.Object || type.isIntersection()) {
      const props = {};
      for (const property of checker.getPropertiesOfType(type)) {
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
        let value = checker.getTypeOfSymbol(property);
        if (optional && value.isUnion()) value = checker.getUnionType(value.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined)));
        props[property.name] = { optional, type: describe(value, depth + 1, inner) };
      }
      const indexes = checker.getIndexInfosOfType(type).map((info) => ({ key: relative(checker.typeToString(info.keyType)), value: describe(info.type, depth + 1, inner) }));
      return { object: sortKeys(props), ...(indexes.length > 0 ? { index: indexes } : {}) };
    }
    return { ref: text };
  };
  // the property every member holds as a string literal, `type` or `kind` first
  const discriminant = (members) => {
    if (members.length < 2 || !members.every((member) => member.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return undefined;
    const names = ['type', 'kind', ...checker.getPropertiesOfType(members[0]).map((property) => property.name)];
    return names.find((name) => members.every((member) => {
      const property = checker.getPropertyOfType(member, name);
      return property !== undefined && (checker.getTypeOfSymbol(property).flags & ts.TypeFlags.StringLiteral) !== 0;
    }));
  };
  return (type) => describe(type, 0, []);
}

function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The described contracts of the sources under root. */
export function describeContracts(root = ROOT, contracts = CONTRACTS) {
  const files = [...new Set(contracts.map((contract) => join(root, contract.file)))];
  const program = ts.createProgram(files, compilerOptions(root));
  const checker = program.getTypeChecker();
  const describe = describer(checker, root);
  const out = {};
  for (const contract of contracts) {
    const source = program.getSourceFile(join(root, contract.file));
    if (!source) throw new Error(`${contract.file} is not in the program`);
    const symbol = checker.getSymbolAtLocation(source)?.exports?.get(contract.type);
    if (!symbol) throw new Error(`${contract.file} exports no ${contract.type}`);
    out[contract.type] = describe(checker.getDeclaredTypeOfSymbol(symbol));
  }
  return out;
}

export function readProtocolVersion(file = VERSION_FILE) {
  const text = readFileSync(file, 'utf8');
  const version = /export const PROTOCOL_VERSION = (\d+);/.exec(text);
  const preRelease = /export const PROTOCOL_PRE_RELEASE: boolean = (true|false);/.exec(text);
  const features = /export const FEATURES: readonly string\[\] = \[([^\]]*)\];/.exec(text);
  if (!version || !preRelease || !features) throw new Error(`${file} does not declare PROTOCOL_VERSION, PROTOCOL_PRE_RELEASE and FEATURES in their usual form`);
  return { protocolVersion: Number(version[1]), preRelease: preRelease[1] === 'true', features: [...features[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) };
}

export function snapshot(root = ROOT, contracts = CONTRACTS, versionFile = VERSION_FILE) {
  return { ...readProtocolVersion(versionFile), contracts: describeContracts(root, contracts) };
}

const text = (value) => JSON.stringify(value);
const isObject = (value) => typeof value === 'object' && value !== null;

// Differences between an older and a newer description. A table may gain entries; an object may gain optional properties;
// anything else that differs breaks an older peer.
function compare(previous, next, where, found, table) {
  if (text(previous) === text(next)) return;
  if (isObject(previous) && isObject(previous.object) && isObject(next) && isObject(next.object)) {
    for (const [name, property] of Object.entries(previous.object)) {
      const now = next.object[name];
      if (!now) found.breaking.push(`${where}.${name} was removed`);
      else if (now.optional !== property.optional) found.breaking.push(`${where}.${name} became ${now.optional ? 'optional' : 'required'}`);
      else compare(property.type, now.type, `${where}.${name}`, found, false);
    }
    for (const [name, property] of Object.entries(next.object)) {
      if (previous.object[name]) continue;
      if (table) found.additive.push(`${where}.${name} was added`);
      else if (property.optional) found.additive.push(`${where}.${name} was added (optional)`);
      else found.breaking.push(`${where}.${name} was added as required`);
    }
    if (text(previous.index) !== text(next.index)) found.breaking.push(`${where} changed its index signature`);
    return;
  }
  if (isObject(previous) && previous.variants && isObject(next) && next.variants === previous.variants) {
    for (const tag of Object.keys(previous.of)) {
      if (!(tag in next.of)) found.breaking.push(`${where}[${previous.variants}=${tag}] was removed`);
      else compare(previous.of[tag], next.of[tag], `${where}[${previous.variants}=${tag}]`, found, false);
    }
    for (const tag of Object.keys(next.of)) if (!(tag in previous.of)) found.additive.push(`${where}[${previous.variants}=${tag}] was added`);
    return;
  }
  found.breaking.push(`${where} changed from ${text(previous).slice(0, 200)} to ${text(next).slice(0, 200)}`);
}

/**
 * Whether next may follow previous: a breaking change needs a protocolVersion bump, an addition a new welcome feature, and a
 * frozen contract never changes. `waivable` says whether every error is one previous's pre-release state lets a writer accept.
 */
export function checkSnapshots(previous, next, contracts = CONTRACTS) {
  const kind = new Map(contracts.map((contract) => [contract.type, contract]));
  const found = { breaking: [], additive: [] };
  for (const name of Object.keys(previous.contracts)) {
    if (!(name in next.contracts)) found.breaking.push(`${name} was removed`);
    else compare(previous.contracts[name], next.contracts[name], name, found, kind.get(name)?.table === true);
  }
  for (const name of Object.keys(next.contracts)) if (!(name in previous.contracts)) found.additive.push(`${name} was added`);
  const bumped = next.protocolVersion > previous.protocolVersion;
  const newFeatures = next.features.filter((feature) => !previous.features.includes(feature));
  const errors = [];
  if (next.protocolVersion < previous.protocolVersion) errors.push(`protocolVersion went down from ${previous.protocolVersion} to ${next.protocolVersion}`);
  for (const name of Object.keys(previous.contracts)) {
    if (kind.get(name)?.frozen && text(previous.contracts[name]) !== text(next.contracts[name])) errors.push(`${name} is frozen across every protocol version and changed`);
  }
  if (!bumped && found.breaking.length > 0) errors.push(...found.breaking.map((change) => `breaking without a protocolVersion bump: ${change}`));
  if (!bumped && found.additive.length > 0 && newFeatures.length === 0) errors.push(...found.additive.map((change) => `additive change no new welcome feature names: ${change}`));
  if (!bumped && previous.features.some((feature) => !next.features.includes(feature))) errors.push('a welcome feature was removed without a protocolVersion bump');
  const reentered = previous.preRelease !== true && next.preRelease === true;
  if (reentered) errors.push('PROTOCOL_PRE_RELEASE went back to true after a release');
  const current = text(previous) === text(next);
  return { ok: errors.length === 0, errors, waivable: previous.preRelease === true && !reentered, breaking: found.breaking, additive: found.additive, current };
}

const PRE_RELEASE_HINT = 'while PROTOCOL_PRE_RELEASE is true, rerun with --allow-breaking to accept it; otherwise bump PROTOCOL_VERSION or name the addition in FEATURES (src/remote/protocol-version.ts)';

/** The command line; returns the exit code. The paths default to this repository's. */
export function run(argv, { root = ROOT, contracts = CONTRACTS, versionFile = VERSION_FILE, snapshotPath = SNAPSHOT_PATH } = {}) {
  const next = snapshot(root, contracts, versionFile);
  const against = argv.indexOf('--against');
  if (against !== -1) {
    const file = argv[against + 1];
    if (!file) throw new Error('--against needs the older snapshot file');
    const result = checkSnapshots(JSON.parse(readFileSync(file, 'utf8')), next, contracts);
    if (result.ok) {
      console.log(`the wire contracts are compatible with ${file}`);
      return 0;
    }
    // the write mode's --allow-breaking accepted these into the committed snapshot, which --check compares
    const report = result.waivable ? console.log : console.error;
    for (const error of result.errors) report(result.waivable ? `accepted while the protocol is pre-release: ${error}` : error);
    return result.waivable ? 0 : 1;
  }
  const result = checkSnapshots(JSON.parse(readFileSync(snapshotPath, 'utf8')), next, contracts);
  if (argv.includes('--check')) {
    for (const error of result.errors) console.error(error);
    if (result.current) {
      console.log(`the wire contracts match ${snapshotPath}`);
      return 0;
    }
    console.error(result.ok
      ? `the contracts changed compatibly; run node scripts/protocol-compat.mjs and commit ${snapshotPath}`
      : `the contracts changed incompatibly; ${PRE_RELEASE_HINT}`);
    return 1;
  }
  if (!result.ok && !(result.waivable && argv.includes('--allow-breaking'))) {
    for (const error of result.errors) console.error(error);
    console.error(result.waivable
      ? `refused to write ${snapshotPath}; ${PRE_RELEASE_HINT}`
      : `refused to write ${snapshotPath}: the protocol is released, so bump PROTOCOL_VERSION or name the addition in FEATURES (src/remote/protocol-version.ts); a frozen contract never changes`);
    return 1;
  }
  for (const error of result.errors) console.log(`accepted with --allow-breaking: ${error}`);
  writeFileSync(snapshotPath, `${JSON.stringify(next, null, 1)}\n`);
  console.log(`wrote ${snapshotPath}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
