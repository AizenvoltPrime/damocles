// The agent's theme drafts (docs/invariants.md "Desktop themes"): drafts/<draftId>.json under the theme store, each owned by one
// chat ({authority, sessionId}). Every method runs inside the store's write lane.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { validateTheme, type ThemeFile } from '../../shared/themes/schema';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { MAX_STATE_FILE_BYTES, readCappedOrNull, UnreadableFile } from './state-file';
import { eachLimited, READ_CONCURRENCY } from './store';

export const DRAFTS_FOLDER = 'drafts';
export const MAX_DRAFTS_PER_CHAT = 3;
export const MAX_DRAFTS = 20;

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DraftOwner {
  // the core's authority: 'local' on this computer
  readonly authority: string;
  readonly sessionId: string;
  readonly toolCallId: string;
}

export interface ThemeDraft {
  readonly id: string;
  readonly owner: DraftOwner;
  readonly createdAt: number;
  // when the draft was last written; put stamps it, whatever the caller passed
  readonly updatedAt?: number;
  // the theme the draft edits; null for a new theme
  readonly baseThemeId: string | null;
  // sha256 of the base's theme.json text when the draft was made; null when the draft makes a new theme
  readonly baseHash: string | null;
  readonly theme: ThemeFile;
}

export class DraftLimitError extends Error {
  readonly limit: 'chat' | 'total';

  constructor(limit: 'chat' | 'total') {
    super(limit === 'chat' ? `A chat keeps at most ${MAX_DRAFTS_PER_CHAT} theme drafts` : `At most ${MAX_DRAFTS} theme drafts are kept`);
    this.limit = limit;
  }
}

export interface DraftStore {
  get(id: string): Promise<ThemeDraft | undefined>;
  list(): Promise<ThemeDraft[]>;
  // writes `draft`, refused past MAX_DRAFTS_PER_CHAT of its chat or MAX_DRAFTS in all; a draft that replaces itself counts once
  put(draft: ThemeDraft): Promise<void>;
  remove(id: string): Promise<void>;
  // every draft of the chat; how many went
  removeOwnedBy(owner: Pick<DraftOwner, 'authority' | 'sessionId'>): Promise<number>;
  // every draft another authority owns (a remote host's, through the relay) last written before `before`, but those of `keep`;
  // how many went
  removeRelayedBefore(localAuthority: string, before: number, keep?: ReadonlySet<string>): Promise<number>;
  // every draft of every chat of the authority; how many went
  removeOfAuthority(authority: string): Promise<number>;
  // the authorities that own a draft
  authorities(): Promise<string[]>;
  // every draft, at core start; how many went
  sweep(): Promise<number>;
  newId(): string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function draftOf(raw: unknown, id: string): ThemeDraft | undefined {
  if (!isRecord(raw) || raw['id'] !== id || !isRecord(raw['owner']) || typeof raw['createdAt'] !== 'number') return undefined;
  const owner = raw['owner'];
  if (typeof owner['authority'] !== 'string' || typeof owner['sessionId'] !== 'string' || typeof owner['toolCallId'] !== 'string') return undefined;
  const baseThemeId = raw['baseThemeId'];
  const baseHash = raw['baseHash'];
  if ((baseThemeId !== null && typeof baseThemeId !== 'string') || (baseHash !== null && typeof baseHash !== 'string')) return undefined;
  const theme = validateTheme(raw['theme']);
  if (!theme.ok) return undefined;
  const updatedAt = typeof raw['updatedAt'] === 'number' ? { updatedAt: raw['updatedAt'] } : {};
  return { id, owner: { authority: owner['authority'], sessionId: owner['sessionId'], toolCallId: owner['toolCallId'] }, createdAt: raw['createdAt'], ...updatedAt, baseThemeId, baseHash, theme: theme.theme };
}

const sameChat = (a: Pick<DraftOwner, 'authority' | 'sessionId'>, b: Pick<DraftOwner, 'authority' | 'sessionId'>): boolean =>
  a.authority === b.authority && a.sessionId === b.sessionId;

export function createDraftStore(root: string, writeText: (file: string, text: string) => Promise<void>, newId: () => string = randomUUID, log?: (line: string) => void, rule: ThemePathRule = createThemePathRule(root)): DraftStore {
  const folder = path.join(root, DRAFTS_FOLDER);
  const fileOf = (id: string): string => {
    if (!DRAFT_ID.test(id)) throw new Error(`${id} is not a draft id`);
    return path.join(folder, `${id}.json`);
  };
  const idsOf = (names: readonly string[]): string[] => names.flatMap((name) => (name.endsWith('.json') && DRAFT_ID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : []));
  const names = (): Promise<string[]> => fs.readdir(folder).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const ids = async (): Promise<string[]> => {
    await rule.readable(folder);
    return idsOf(await names());
  };
  // a draft's text; null for none, and for a file no draft write makes (not a regular file, or past a draft's size), which is left out
  const textOf = async (id: string): Promise<string | null> => {
    try {
      return await readCappedOrNull(fileOf(id), MAX_STATE_FILE_BYTES);
    } catch (err) {
      if (!(err instanceof UnreadableFile)) throw err;
      log?.(`[themes] the draft ${id} is left out: ${err.message}`);
      return null;
    }
  };
  const get = async (id: string): Promise<ThemeDraft | undefined> => {
    if (!DRAFT_ID.test(id)) return undefined;
    await rule.readable(fileOf(id));
    const text = await textOf(id);
    if (text === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      log?.(`[themes] the draft ${id} does not parse, so it is left out: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    return draftOf(json, id);
  };
  const list = async (): Promise<ThemeDraft[]> => (await eachLimited(await ids(), READ_CONCURRENCY, get)).flatMap((draft) => (draft ? [draft] : []));
  const remove = async (id: string): Promise<void> => {
    await rule.writable(fileOf(id));
    await fs.rm(fileOf(id), { force: true });
  };
  // each draft's owner fields and last write as written, also of a draft whose theme no longer validates
  const rawDrafts = async (): Promise<{ readonly id: string; readonly fields: Record<string, unknown>; readonly updatedAt: unknown }[]> => {
    const found: { readonly id: string; readonly fields: Record<string, unknown>; readonly updatedAt: unknown }[] = [];
    for (const id of await ids()) {
      await rule.readable(fileOf(id));
      const text = await textOf(id);
      if (text === null) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        log?.(`[themes] the draft ${id} does not parse, so the core start's sweep removes it: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (isRecord(raw) && isRecord(raw['owner'])) found.push({ id, fields: raw['owner'], updatedAt: raw['updatedAt'] });
    }
    return found;
  };
  return {
    get,
    list,
    async put(draft) {
      await rule.writable(fileOf(draft.id));
      const others = (await list()).filter((other) => other.id !== draft.id);
      if (others.filter((other) => sameChat(other.owner, draft.owner)).length >= MAX_DRAFTS_PER_CHAT) throw new DraftLimitError('chat');
      if (others.length >= MAX_DRAFTS) throw new DraftLimitError('total');
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await writeText(fileOf(draft.id), `${JSON.stringify({ ...draft, updatedAt: Date.now() })}\n`);
    },
    remove,
    // by the owner fields alone, so a draft whose theme no longer validates goes too
    async removeOwnedBy(owner) {
      const owned = (await rawDrafts()).filter(({ fields }) => fields['authority'] === owner.authority && fields['sessionId'] === owner.sessionId).map(({ id }) => id);
      await Promise.all(owned.map(remove));
      return owned.length;
    },
    async removeRelayedBefore(localAuthority, before, keep) {
      const expired = (await rawDrafts())
        .filter(({ id, fields, updatedAt }) => fields['authority'] !== localAuthority && keep?.has(id) !== true && (typeof updatedAt !== 'number' || updatedAt < before))
        .map(({ id }) => id);
      await Promise.all(expired.map(remove));
      return expired.length;
    },
    async removeOfAuthority(authority) {
      const owned = (await rawDrafts()).filter(({ fields }) => fields['authority'] === authority).map(({ id }) => id);
      await Promise.all(owned.map(remove));
      return owned.length;
    },
    authorities: async () => [...new Set((await rawDrafts()).flatMap(({ fields }) => (typeof fields['authority'] === 'string' ? [fields['authority']] : [])))],
    async sweep() {
      await rule.writable(folder);
      const drafts = idsOf(await names());
      await fs.rm(folder, { recursive: true, force: true });
      return drafts.length;
    },
    newId,
  };
}
