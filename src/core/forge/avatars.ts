import { createHash } from 'node:crypto';
import { MAX_AVATAR_BYTES, type ForgeHttp } from './http';
import { ForgeHttpError, type ForgeServer } from './types';

// Account and commit author pictures for app://damocles/forge/avatar/<key> (docs/invariants.md "GitHub and GitLab
// accounts", avatar route). A token goes only to the server's own origin; any other host (Gravatar) is fetched without one through the SSRF guard.
// Only PNG, JPEG, GIF and WebP pass, by their bytes, never SVG.

export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface Avatar {
  readonly bytes: Uint8Array;
  readonly mime: AvatarMime;
}

/** The opaque key of a picture: SHA-256 of the server id and the picture's URL. */
export function avatarKey(serverId: string, url: string): string {
  return createHash('sha256').update(`${serverId}\n${url}`, 'utf8').digest('hex');
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((byte, index) => bytes[at + index] === byte);

/** The image type the bytes are, or undefined for anything else. */
export function sniffAvatar(bytes: Uint8Array): AvatarMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/** The picture at url; token is sent only when url is on one of the server's own origins. Undefined: not an allowed image. */
export async function fetchAvatar(http: ForgeHttp, server: ForgeServer, url: string, token: () => Promise<string>, log: (line: string) => void): Promise<Avatar | undefined> {
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') return undefined;
  const own = server.origins.has(new URL(url).origin);
  const template = own ? '/avatar' : '/avatar (third party)';
  let response: Awaited<ReturnType<ForgeHttp['request']>>;
  try {
    response = await http.request({ server, url, template, as: 'bytes', maxBytes: MAX_AVATAR_BYTES, ...(own ? { credential: { bearer: await token() } } : {}) });
  } catch (err) {
    // main answers 404 and the renderer keeps the initial; a body over MAX_AVATAR_BYTES ends here too
    log(`[forge] ${server.id} ${template} not shown: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
    throw err;
  }
  const bytes = response.body instanceof Uint8Array ? response.body : new Uint8Array(0);
  const mime = sniffAvatar(bytes);
  if (mime === undefined) log(`[forge] ${server.id} avatar is not PNG, JPEG, GIF or WebP; not shown`);
  return mime === undefined ? undefined : { bytes, mime };
}
