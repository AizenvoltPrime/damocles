import { promises as fsp } from 'fs';
import { join } from 'path';
import { isClientCertificateOrigin, namesCertificate, type ClientCertificateFilter } from '../../shared/client-certificate';

/** This app session's chosen certificates of one browser profile, by `https://host:port` origin. */
export type ClientCertificateRules = ReadonlyMap<string, ClientCertificateFilter>;

/**
 * Replaces `profile.content_settings.exceptions.auto_select_certificate` in the profile's Default/Preferences with exactly
 * `rules`, keeping every other preference; Damocles owns that key ("Browser" in docs/invariants.md).
 * Chrome rewrites the file from memory when it exits, so call this only while no Chrome runs on the profile.
 */
export async function writeClientCertificateRules(userDataDir: string, rules: ClientCertificateRules): Promise<void> {
  const folder = join(userDataDir, 'Default');
  const file = join(folder, 'Preferences');
  let text: string | undefined;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const preferences: unknown = text === undefined ? {} : JSON.parse(text);
  if (!isObject(preferences)) throw new Error(`${file} does not hold a JSON object`);
  const exceptions: Record<string, unknown> = {};
  for (const [origin, filter] of rules) {
    if (!isClientCertificateOrigin(origin)) throw new Error(`${JSON.stringify(origin.slice(0, 200))} is not an https origin`);
    if (!namesCertificate(filter)) throw new Error(`The certificate filter for ${origin} names no field`);
    exceptions[`${origin},*`] = { setting: { filters: [filter] } };
  }
  const profile = objectAt(preferences, 'profile');
  const contentSettings = objectAt(profile, 'content_settings');
  const allExceptions = objectAt(contentSettings, 'exceptions');
  allExceptions['auto_select_certificate'] = exceptions;
  await fsp.mkdir(folder, { recursive: true });
  // a rename replaces the file whole, so Chrome never reads half of it
  const staged = `${file}.damocles-${process.pid}`;
  await fsp.writeFile(staged, JSON.stringify(preferences));
  await fsp.rename(staged, file);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The object under key, made when absent; a key holding anything else is replaced, as Chrome would drop it.
function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const made: Record<string, unknown> = {};
  parent[key] = made;
  return made;
}
