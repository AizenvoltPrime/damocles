// The community store's trust checks (docs/invariants.md "Desktop themes"): the signed list's envelope, signature and payload
// shape, rollback and expiry, the release download hosts and the download's pin.
import { verify, type KeyObject } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import { LOOK_SEEDS, PANELS, type LookColors, type Panel } from '../../../shared/themes/schema';
import { MAX_ENTRY_FONTS, MAX_ENTRY_LICENSES, MAX_ENTRY_THUMBS, MAX_STORE_ENTRIES, STORE_ENTRY_ID, STORE_TEXT_LIMITS } from '../../../shared/themes/store';
import { oneLine } from '../../pi-session/untrusted-text';
import { l, verbatim } from '../../l10n';
import { MAX_ARCHIVE_BYTES } from '../archive';
import { SHA256 } from '../blobs';
import { E2E_HOST } from '../e2e-downloads';

export const STORE_ENVELOPE_FORMAT = 1;
// GitHub release downloads: github.com answers a redirect to release-assets (objects before 2025); the e2e hooks' host only with them on
export const RELEASE_HOSTS: readonly string[] = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export { MAX_ENTRY_FONTS, MAX_ENTRY_LICENSES, MAX_ENTRY_THUMBS, STORE_TEXT_LIMITS };
const MAX_REMOVED = 2000;

const sha256 = Type.String({ pattern: SHA256.source });
const raw = (key: keyof typeof STORE_TEXT_LIMITS) => Type.String({ minLength: 1, maxLength: STORE_TEXT_LIMITS[key] * 4 });
const httpsUrl = Type.String({ pattern: '^https://', maxLength: 2048 });
const entryId = Type.String({ pattern: STORE_ENTRY_ID.source });
const isoTime = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' });
const seeds = Type.Object(Object.fromEntries(LOOK_SEEDS.map((seed) => [seed, Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })])));
const kind = Type.Union([Type.Literal('dark'), Type.Literal('light')]);
const thumbs = Type.Array(Type.Object({ panel: Type.Union(PANELS.map((panel) => Type.Literal(panel))), url: httpsUrl, sha256 }), { maxItems: MAX_ENTRY_THUMBS });

const EntrySchema = Type.Object({
  id: entryId,
  name: raw('name'),
  author: raw('author'),
  description: Type.String({ maxLength: STORE_TEXT_LIMITS.description * 4 }),
  kinds: Type.Array(kind, { minItems: 1, maxItems: 2 }),
  version: raw('version'),
  file: Type.Object({ url: httpsUrl, sha256, bytes: Type.Integer({ minimum: 1, maximum: MAX_ARCHIVE_BYTES }) }),
  colors: Type.Object({ dark: Type.Optional(seeds), light: Type.Optional(seeds) }),
  fonts: Type.Array(Type.Object({ family: raw('name'), license: raw('license') }), { maxItems: MAX_ENTRY_FONTS }),
  thumbnails: Type.Object({ dark: Type.Optional(thumbs), light: Type.Optional(thumbs) }),
  licenses: Type.Array(raw('license'), { maxItems: MAX_ENTRY_LICENSES }),
  hasCss: Type.Boolean(),
  hasLayout: Type.Boolean(),
  hasCharacters: Type.Boolean(),
  hasMoving: Type.Boolean(),
  minAppVersion: Type.String({ pattern: '^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}$' }),
});
const RemovedSchema = Type.Object({ id: entryId, sha256: Type.Optional(sha256), version: Type.Optional(raw('version')), reason: raw('reason') });
const PayloadSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  issuedAt: isoTime,
  expiresAt: isoTime,
  entries: Type.Array(EntrySchema, { maxItems: MAX_STORE_ENTRIES }),
  removed: Type.Array(RemovedSchema, { maxItems: MAX_REMOVED }),
});
const EnvelopeSchema = Type.Object({
  format: Type.Number(),
  keyId: Type.String({ pattern: '^[0-9a-f]{16}$' }),
  payload: Type.String({ minLength: 2 }),
  signature: Type.String({ pattern: '^[A-Za-z0-9+/]{86}==$' }),
});

export interface StoreEnvelope {
  readonly format: 1;
  readonly keyId: string;
  readonly payload: string;
  readonly signature: string;
}

export interface StoreThumbnail { readonly panel: Panel; readonly url: string; readonly sha256: string }

/** One theme of the store list; name, author, description, licenses and font licenses are outside text, cleaned to one line. */
export interface StoreEntry {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly description: string;
  readonly kinds: ReadonlyArray<'dark' | 'light'>;
  readonly version: string;
  readonly file: { readonly url: string; readonly sha256: string; readonly bytes: number };
  readonly colors: { readonly dark?: LookColors; readonly light?: LookColors };
  readonly fonts: ReadonlyArray<{ readonly family: string; readonly license: string }>;
  readonly thumbnails: { readonly dark?: readonly StoreThumbnail[]; readonly light?: readonly StoreThumbnail[] };
  readonly licenses: readonly string[];
  readonly hasCss: boolean;
  readonly hasLayout: boolean;
  readonly hasCharacters: boolean;
  // a look's wallpaper is an animated image or a video
  readonly hasMoving: boolean;
  readonly minAppVersion: string;
}

/** A theme the store withdrew; `reason` is outside text, cleaned to one line. */
export interface StoreRemoved { readonly id: string; readonly sha256?: string; readonly version?: string; readonly reason: string }

export interface StorePayload {
  readonly sequence: number;
  // epoch milliseconds, from the payload's ISO times
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entries: readonly StoreEntry[];
  readonly removed: readonly StoreRemoved[];
}

export type StoreVerdict =
  | { readonly ok: true; readonly envelope: StoreEnvelope; readonly payload: StorePayload }
  | { readonly ok: false; readonly reason: LocalizedText };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const refused = (reason: LocalizedText): StoreVerdict => ({ ok: false, reason });
const malformed = (detail: string): StoreVerdict => refused(l('The community store list is signed but malformed ({0}), so Damocles did not use it.', verbatim(detail.slice(0, 300))));

/**
 * Checks a parsed envelope: its format, a key Damocles knows, the Ed25519 signature over the payload's UTF-8 bytes, then the
 * payload's shape. Rollback and expiry are `checkFreshness`'s, since a cached list is read back without them. `e2e`: the e2e
 * hooks' host counts as a release host.
 */
export function verifyEnvelope(envelope: unknown, keys: ReadonlyMap<string, KeyObject>, e2e = false): StoreVerdict {
  if (!isRecord(envelope) || typeof envelope['payload'] !== 'string' || typeof envelope['signature'] !== 'string' || typeof envelope['keyId'] !== 'string') {
    return refused(l('The community store list is not signed, so Damocles did not use it.'));
  }
  if (envelope['format'] !== STORE_ENVELOPE_FORMAT) return refused(l('The community store list has a format this Damocles does not read, so Damocles did not use it. A newer Damocles may read it.'));
  if (!Value.Check(EnvelopeSchema, envelope)) return refused(l('The community store list is not signed, so Damocles did not use it.'));
  const { keyId, payload, signature } = envelope as Static<typeof EnvelopeSchema>;
  const key = keys.get(keyId);
  if (key === undefined) return refused(l('The community store list is signed with a key Damocles does not know ({0}), so Damocles did not use it.', keyId));
  if (!verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'))) {
    return refused(l('The community store list\'s signature does not match its contents, so Damocles did not use it.'));
  }
  let json: unknown;
  try {
    json = JSON.parse(payload) as unknown;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return malformed(err.message);
  }
  const parsed = parsePayload(json, e2e);
  if ('error' in parsed) return malformed(parsed.error);
  return { ok: true, envelope: { format: STORE_ENVELOPE_FORMAT, keyId, payload, signature }, payload: parsed.payload };
}

/** Why a verified list must not replace what this computer saw: a sequence below the highest seen, or an expiresAt passed. */
export function checkFreshness(payload: StorePayload, options: { readonly highestSequence: number | undefined; readonly now: number }): LocalizedText | undefined {
  if (options.highestSequence !== undefined && payload.sequence < options.highestSequence) {
    return l('The community store list is older (number {0}) than one Damocles already saw (number {1}), so Damocles kept the newer list.', String(payload.sequence), String(options.highestSequence));
  }
  if (payload.expiresAt <= options.now) {
    return l('The community store list expired on {0}, so Damocles did not use it.', new Date(payload.expiresAt).toISOString().slice(0, 10));
  }
  return undefined;
}

// Unknown keys are dropped, not refused, so a later list that adds a field still reads in this app.
function parsePayload(json: unknown, e2e: boolean): { readonly payload: StorePayload } | { readonly error: string } {
  if (!Value.Check(PayloadSchema, json)) {
    const first = Value.Errors(PayloadSchema, json)[0];
    return { error: first ? `${first.instancePath || '/'}: ${first.message}` : 'not a store payload' };
  }
  const shaped = json as Static<typeof PayloadSchema>;
  const issuedAt = Date.parse(shaped.issuedAt);
  const expiresAt = Date.parse(shaped.expiresAt);
  if (Number.isNaN(issuedAt)) return { error: '/issuedAt: not a time' };
  if (Number.isNaN(expiresAt)) return { error: '/expiresAt: not a time' };
  if (expiresAt <= issuedAt) return { error: '/expiresAt: not after issuedAt' };
  const entries: StoreEntry[] = [];
  const ids = new Set<string>();
  for (const [i, entry] of shaped.entries.entries()) {
    const at = `/entries/${i}`;
    if (ids.has(entry.id)) return { error: `${at}/id: ${entry.id} is listed twice` };
    ids.add(entry.id);
    if (new Set(entry.kinds).size !== entry.kinds.length) return { error: `${at}/kinds: names a kind twice` };
    for (const kind of entry.kinds) if (entry.colors[kind] === undefined) return { error: `${at}/colors/${kind}: missing` };
    if (!releaseDownloadAllowed(entry.file.url, e2e)) return { error: `${at}/file/url: not on a GitHub release host` };
    for (const kind of ['dark', 'light'] as const) {
      const panels = (entry.thumbnails[kind] ?? []).map((thumb) => thumb.panel);
      if (new Set(panels).size !== panels.length) return { error: `${at}/thumbnails/${kind}: names a panel twice` };
    }
    const name = oneLine(entry.name, STORE_TEXT_LIMITS.name);
    const author = oneLine(entry.author, STORE_TEXT_LIMITS.author);
    const version = oneLine(entry.version, STORE_TEXT_LIMITS.version);
    if (name === undefined || author === undefined || version === undefined) return { error: `${at}: name, author or version is empty` };
    const fonts = entry.fonts.map((font) => ({ family: oneLine(font.family, STORE_TEXT_LIMITS.name), license: oneLine(font.license, STORE_TEXT_LIMITS.license) }));
    const licenses = entry.licenses.map((license) => oneLine(license, STORE_TEXT_LIMITS.license));
    if (fonts.some((font) => font.family === undefined || font.license === undefined) || licenses.some((license) => license === undefined)) {
      return { error: `${at}: a font or license is empty` };
    }
    const thumbnails = (list: readonly StoreThumbnail[] | undefined): readonly StoreThumbnail[] | undefined =>
      list?.map(({ panel, url, sha256: sha }) => ({ panel, url, sha256: sha }));
    const dark = thumbnails(entry.thumbnails.dark);
    const light = thumbnails(entry.thumbnails.light);
    entries.push({
      id: entry.id,
      name,
      author,
      description: oneLine(entry.description, STORE_TEXT_LIMITS.description) ?? '',
      kinds: [...entry.kinds],
      version,
      file: { url: entry.file.url, sha256: entry.file.sha256, bytes: entry.file.bytes },
      colors: {
        ...(entry.colors.dark ? { dark: seedsOf(entry.colors.dark) } : {}),
        ...(entry.colors.light ? { light: seedsOf(entry.colors.light) } : {}),
      },
      fonts: fonts as Array<{ family: string; license: string }>,
      thumbnails: { ...(dark ? { dark } : {}), ...(light ? { light } : {}) },
      licenses: licenses as string[],
      hasCss: entry.hasCss,
      hasLayout: entry.hasLayout,
      hasCharacters: entry.hasCharacters,
      hasMoving: entry.hasMoving,
      minAppVersion: entry.minAppVersion,
    });
  }
  const removed: StoreRemoved[] = [];
  for (const [i, gone] of shaped.removed.entries()) {
    const reason = oneLine(gone.reason, STORE_TEXT_LIMITS.reason);
    const version = gone.version === undefined ? undefined : oneLine(gone.version, STORE_TEXT_LIMITS.version);
    if (reason === undefined || (gone.version !== undefined && version === undefined)) return { error: `/removed/${i}: reason or version is empty` };
    removed.push({ id: gone.id, ...(gone.sha256 !== undefined ? { sha256: gone.sha256 } : {}), ...(version !== undefined ? { version } : {}), reason });
  }
  return { payload: { sequence: shaped.sequence, issuedAt, expiresAt, entries, removed } };
}

function seedsOf(colors: Record<string, string>): LookColors {
  return Object.fromEntries(LOOK_SEEDS.map((seed) => [seed, colors[seed]!.toLowerCase()])) as unknown as LookColors;
}

/** Whether a store entry's download may start at, or be redirected to, `url`: https on a GitHub release host, or the e2e host with the hooks on. */
export function releaseDownloadAllowed(url: string, e2e: boolean): boolean {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '' || target.port !== '') return false;
  return RELEASE_HOSTS.includes(target.hostname) || (e2e && target.hostname === E2E_HOST);
}

/** A store download whose bytes are not the ones the signed list pins. */
export class StorePinError extends LocalizedError {}

/** Refuses a download unless its byte count and its SHA-256 equal the entry's pin; call it before anything parses the bytes. */
export function assertPinned(downloaded: { readonly sha256: string; readonly bytes: number }, file: { readonly sha256: string; readonly bytes: number }): void {
  if (downloaded.bytes !== file.bytes) {
    throw new StorePinError(l('The downloaded theme is {0} bytes, but the community store list pins {1} bytes, so nothing was installed.', String(downloaded.bytes), String(file.bytes)));
  }
  if (downloaded.sha256 !== file.sha256) {
    throw new StorePinError(l('The downloaded theme\'s SHA-256 does not match the community store list\'s pin, so nothing was installed.'));
  }
}
