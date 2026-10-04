import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_SETTING_KEYS } from '../chat-settings';

const ROOT = process.cwd();
const CORE = path.join(ROOT, 'src', 'core');

interface Property {
  scope?: string;
}

function contributedProperties(): Record<string, Property> {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, Property> } };
  };
  return manifest.contributes.configuration.properties;
}

function coreSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : coreSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** The top-level arguments of the call whose `(` is at `open`, as source text. */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last !== '') args.push(last);
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}

// A literal key, or a template such as `damocles.team.${role}Model` as a pattern over package.json keys.
function keyPattern(arg: string): RegExp | undefined {
  const literal = /^(["'`])([^"'`]*)\1$/.exec(arg);
  if (!literal) return undefined;
  const escaped = literal[2]!.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('[A-Za-z]+')}$`);
}

/** The index of the bracket that closes the one at `open`, skipping string contents. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if ((ch === ')' || ch === '}' || ch === ']') && --depth === 0) return i;
  }
  throw new Error('unbalanced block');
}

// Generic helpers that take the key from their caller; their callers are scanned instead.
const KEY_FORWARDERS = new Set([
  path.join(CORE, 'chat-panel', 'settings-manager', 'utils.ts'),
  path.join(CORE, 'chat-panel', 'message-router', 'setting-write.ts'),
]);

// Methods that pass a folder with a computed key, and only for a CHAT_SETTING_KEYS member, which they check themselves.
const KEY_FORWARDING_METHODS: readonly { file: string; method: string }[] = [
  { file: path.join(CORE, 'chat-panel', 'settings-manager', 'managers', 'config-manager.ts'), method: 'settingSources' },
];

/** The spans of the bodies of `file`'s KEY_FORWARDING_METHODS. */
function forwardingBodies(file: string, text: string): [number, number][] {
  return KEY_FORWARDING_METHODS.filter((entry) => entry.file === file).flatMap(({ method }) => {
    const definitions = [...text.matchAll(new RegExp(`\\b${method}\\s*\\([^)]*\\)\\s*(?::[^{;]*)?\\{`, 'g'))];
    if (definitions.length !== 1) throw new Error(`${path.relative(ROOT, file)} defines ${method} ${definitions.length} times`);
    const open = definitions[0]!.index + definitions[0]![0].length - 1;
    return [[open, closingBracket(text, open)] as [number, number]];
  });
}

interface FolderAccess {
  file: string;
  call: string;
  keys: RegExp | undefined;
  inForwardingMethod: boolean;
}

/**
 * Every settings read or write in core that passes a folder: get with 3 arguments, inspect with 2 and update with 4, on a
 * settings or config receiver or with a folder argument on any receiver, and updateConfigAtEffectiveScope with options.
 */
function folderAccesses(): FolderAccess[] {
  return coreSources(CORE).flatMap((file) => accessesIn(file, fs.readFileSync(file, 'utf8')));
}

function accessesIn(file: string, text: string): FolderAccess[] {
  const found: FolderAccess[] = [];
  const bodies = forwardingBodies(file, text);
  const inForwardingMethod = (index: number): boolean => bodies.some(([start, end]) => index > start && index < end);
  const calls = /\.\s*(get|inspect|update)\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\s*\(|\bupdateConfigAtEffectiveScope\s*(?:<[^>(]*>)?\s*\(/g;
  for (const match of text.matchAll(calls)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(text, open);
    const method = match[1];
    if (method === undefined) {
      if (args.length < 4) continue;
      found.push({ file, call: match[0], keys: keyPattern(args[1]!), inForwardingMethod: inForwardingMethod(match.index) });
      continue;
    }
    const folderIndex = method === 'get' ? 2 : method === 'inspect' ? 1 : 3;
    if (args.length <= folderIndex) continue;
    const settingsReceiver = /\b(?:settings|config)\s*$/.test(text.slice(Math.max(0, match.index - 40), match.index));
    if (!settingsReceiver && !/folder/i.test(args[folderIndex]!)) continue;
    found.push({ file, call: match[0], keys: keyPattern(args[0]!), inForwardingMethod: inForwardingMethod(match.index) });
  }
  return found;
}

describe('per-chat settings (D38)', () => {
  it('declares every per-chat key with "scope": "resource" in package.json', () => {
    const properties = contributedProperties();
    for (const key of CHAT_SETTING_KEYS) {
      expect(properties[key], key).toBeDefined();
      expect(properties[key]?.scope, key).toBe('resource');
    }
  });

  it('passes a folder only for per-chat keys, so every key read with a folder declares resource scope', () => {
    const accesses = folderAccesses();
    expect(accesses.length).toBeGreaterThan(20);
    const keys = Object.keys(contributedProperties());
    for (const access of accesses) {
      const where = `${path.relative(ROOT, access.file)}: ${access.call}`;
      if (access.keys === undefined) {
        expect(KEY_FORWARDERS.has(access.file) || access.inForwardingMethod, `${where} passes a folder with a key that is not a literal`).toBe(true);
        continue;
      }
      const matching = keys.filter((key) => access.keys!.test(key));
      expect(matching.length, where).toBeGreaterThan(0);
      for (const key of matching) expect(CHAT_SETTING_KEYS.has(key), `${where} reads ${key} with a folder`).toBe(true);
    }
  });

  it('sees a folder passed through any receiver, and exempts a computed key only inside settingSources', () => {
    const configManager = KEY_FORWARDING_METHODS[0]!.file;
    const sample = [
      'function a(store, folder, key) { store.get("damocles.maxTurns", 1, folder); other.inspect(key, chatFolder); db.prepare(q).get(x, y, z); }',
      'class C { private settingSources(folder: F): R { return this.platform.settings.inspect(key, folder); } }',
    ].join('\n');
    expect(accessesIn(configManager, sample).map((access) => [access.call, access.keys?.source, access.inForwardingMethod])).toEqual([
      ['.get(', '^damocles\\.maxTurns$', false],
      ['.inspect(', undefined, false],
      ['.inspect(', undefined, true],
    ]);
  });
});
