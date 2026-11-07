// The design folder files core writes (PD-26): manifest.json and decisions.md, and the folder's content hash and listing.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DesignCheckIssue, DesignFidelity, DesignFileInfo, DesignStatus } from '../../shared/types/design';
import type { DesignDecisionRecord } from './design-entries';
import type { ScreenJourney } from './journey';
import { SCREEN_FILE } from '../../shared/design-paths';
import { ASSETS_DIR, DECISIONS_FILE, MANIFEST_FILE, MAX_DESIGN_FILES, SCREENS_DIR, TOKENS_FILE } from './design-paths';
import { writeJsonAtomic, writeTextAtomic, type DesignVersionRecord } from './design-state';

export interface ManifestScreen {
  readonly id: string;
  readonly file: string;
  readonly contentHash: string;
  readonly check: { readonly errors: number; readonly warnings: readonly Pick<DesignCheckIssue, 'rule' | 'element' | 'message' | 'more'>[] };
  /** The latest DesignCheck at widths (FULL), at the folder's content hash then; the issues are in the state folder's checks/. */
  readonly widthCheck?: { readonly contentHash: string; readonly widths: readonly number[]; readonly errors: number; readonly warnings: number };
  /** The latest DesignScreenshot of the screen, at the folder's content hash then. */
  readonly screenshot?: { readonly contentHash: string; readonly widths: readonly number[] };
  /** An interactive design's journey for the screen, or DesignCheck's waiver (PD-21); absent where no journey gate applies. */
  readonly journey?: ScreenJourney;
}

export interface DesignManifest {
  readonly schemaVersion: 1;
  readonly designId: string;
  readonly plan: string | null;
  readonly fidelity: DesignFidelity | null;
  readonly status: DesignStatus;
  readonly version: number | null;
  readonly screens: readonly ManifestScreen[];
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Every regular file below `folder`, relative with forward slashes and sorted; links are skipped, as no design file is one.
 * Throws past `MAX_DESIGN_FILES`.
 */
export async function listDesignFiles(folder: string): Promise<DesignFileInfo[]> {
  const files: DesignFileInfo[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && prefix === '') return;
      throw err;
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        if (files.length >= MAX_DESIGN_FILES) throw new Error(`The design folder holds more than ${MAX_DESIGN_FILES} files`);
        files.push({ path: relative, bytes: (await fs.stat(path.join(dir, entry.name))).size });
      }
    }
  };
  await walk(folder, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every screen file, `screens/<name>.html` as the folder spells it, sorted; a screen argument names one of these exactly. */
export async function listScreenFiles(folder: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(folder, SCREENS_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && SCREEN_FILE.test(`${SCREENS_DIR}/${entry.name}`)).map((entry) => `${SCREENS_DIR}/${entry.name}`).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The SHA-256 of one file's bytes, streamed, so no file is held whole. */
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function presentFileHash(file: string): Promise<string> {
  try {
    return await fileHash(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/**
 * Each screen's render inputs hashed, by screen file: its bytes, tokens.css and every file of assets/, all a screen may load
 * (DesignCheck's `checkResourceRef`). Width checks reuse a probe at the same hash, and DesignParity compares it with the
 * delivered version's.
 */
export async function renderInputHashes(folder: string, screenFiles: readonly string[]): Promise<Record<string, string>> {
  const shared = createHash('sha256');
  const assets = (await listDesignFiles(path.join(folder, ASSETS_DIR))).map((file) => `${ASSETS_DIR}/${file.path}`);
  for (const relative of [TOKENS_FILE, ...assets]) shared.update(`${relative}\0${await presentFileHash(path.join(folder, ...relative.split('/')))}\n`);
  const inputs = shared.digest('hex');
  const hashes: Record<string, string> = {};
  for (const file of screenFiles) hashes[file] = createHash('sha256').update(`${inputs}\n${file}\0${await presentFileHash(path.join(folder, ...file.split('/')))}`).digest('hex');
  return hashes;
}

/** The folder's content: every file but manifest.json and decisions.md, which status and decisions rebuild (PD-24). */
export async function designContentHash(folder: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listDesignFiles(folder)) {
    if (file.path === MANIFEST_FILE || file.path === DECISIONS_FILE) continue;
    hash.update(`${file.path}\0${await fileHash(path.join(folder, ...file.path.split('/')))}\n`);
  }
  return hash.digest('hex');
}

function manifestOf(value: unknown, designId: string): DesignManifest | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 1 || value['designId'] !== designId) return undefined;
  const { plan, fidelity, status, version, screens, updatedAt } = value;
  if (plan !== null && typeof plan !== 'string') return undefined;
  if (fidelity !== null && fidelity !== 'static' && fidelity !== 'interactive') return undefined;
  if (status !== 'draft' && status !== 'finished') return undefined;
  if (version !== null && typeof version !== 'number') return undefined;
  if (!Array.isArray(screens) || typeof updatedAt !== 'string') return undefined;
  return value as unknown as DesignManifest;
}

/** The folder's manifest, or a new draft one when there is none yet. Throws for a manifest that does not parse. */
export async function readManifest(folder: string, designId: string): Promise<DesignManifest> {
  const file = path.join(folder, MANIFEST_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { schemaVersion: 1, designId, plan: null, fidelity: null, status: 'draft', version: null, screens: [], updatedAt: new Date().toISOString() };
  }
  const manifest = manifestOf(JSON.parse(text) as unknown, designId);
  if (!manifest) throw new Error(`${file} is not this design's manifest`);
  return manifest;
}

// Per folder, the manifest updates still to run: tools of one turn may run at once, and each update reads what the last wrote.
const manifestChains = new Map<string, Promise<unknown>>();

/** Replaces manifest.json with what `change` makes of it; updates of one folder run one at a time. */
export function updateManifest(folder: string, designId: string, change: (current: DesignManifest) => Omit<DesignManifest, 'updatedAt'>): Promise<DesignManifest> {
  const run = (manifestChains.get(folder) ?? Promise.resolve()).then(async () => {
    const next: DesignManifest = { ...change(await readManifest(folder, designId)), updatedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(folder, MANIFEST_FILE), next);
    return next;
  });
  const settled = run.then(() => undefined, () => undefined);
  manifestChains.set(folder, settled);
  void settled.then(() => {
    if (manifestChains.get(folder) === settled) manifestChains.delete(folder);
  });
  return run;
}

/**
 * Sets the manifest's version to `latest`, the state folder's (PD-24), after the folder's files came back from a checkpoint:
 * finished only while the folder holds that version's content, else a draft.
 */
export async function syncManifestVersion(folder: string, designId: string, latest: DesignVersionRecord | undefined): Promise<DesignManifest> {
  const finished = latest !== undefined && (await designContentHash(folder)) === latest.contentHash;
  return updateManifest(folder, designId, (current) => ({ ...current, version: latest?.version ?? null, status: finished ? 'finished' : 'draft' }));
}

/**
 * A designer write after a finished version: the manifest turns draft and keeps that version, so the design reads as an edit of
 * it. True when the status changed.
 */
export async function markDesignEdited(folder: string, designId: string): Promise<boolean> {
  if ((await readManifest(folder, designId)).status !== 'finished') return false;
  let edited = false;
  await updateManifest(folder, designId, (current) => {
    edited = current.status === 'finished';
    return { ...current, status: 'draft' };
  });
  return edited;
}

/** The Fidelity question's option labels, which the designer is told to offer; only an answer that is one of them sets the fidelity. */
export const FIDELITY_OPTION_LABELS: Readonly<Record<DesignFidelity, string>> = { static: 'Static mockup', interactive: 'Interactive prototype' };

/** The fidelity the latest decision titled Fidelity chose: the option whose label it is, case-blind; null for any other answer. */
export function fidelityOf(decisions: readonly DesignDecisionRecord[]): DesignFidelity | null {
  const decision = [...decisions].reverse().find((candidate) => candidate.title.trim().toLowerCase() === 'fidelity');
  if (!decision) return null;
  const chosen = decision.chosen.trim().toLowerCase();
  return (Object.keys(FIDELITY_OPTION_LABELS) as DesignFidelity[]).find((fidelity) => FIDELITY_OPTION_LABELS[fidelity].toLowerCase() === chosen) ?? null;
}

const DECISIONS_NOTICE = '<!-- Generated by Damocles from the design chat\'s decisions. Edits here are overwritten. -->';

/** decisions.md: a generated-file notice, then one section per decision in branch order. */
export function decisionsMarkdown(decisions: readonly DesignDecisionRecord[]): string {
  const sections = decisions.map((decision) => [
    `## ${decision.id} · ${decision.title}`,
    '',
    `- Chosen: ${decision.chosen}`,
    `- Rejected: ${decision.rejected.length > 0 ? decision.rejected.join('; ') : 'none'}`,
    `- Source: ${decision.source.kind}${decision.source.ref ? ` (${decision.source.ref})` : ''}`,
    `- Files: ${decision.files.length > 0 ? decision.files.join(', ') : 'none'}`,
    ...(decision.supersedes ? [`- Supersedes: ${decision.supersedes}`] : []),
  ].join('\n'));
  return [DECISIONS_NOTICE, '', '# Decisions', '', ...(sections.length > 0 ? [sections.join('\n\n')] : ['No decisions yet.']), ''].join('\n');
}

/** Rebuilds decisions.md and the manifest's fidelity from `decisions`, the active branch's (PD-15). */
export async function writeDecisions(folder: string, designId: string, decisions: readonly DesignDecisionRecord[]): Promise<void> {
  await writeTextAtomic(path.join(folder, DECISIONS_FILE), decisionsMarkdown(decisions));
  const fidelity = fidelityOf(decisions);
  await updateManifest(folder, designId, (current) => ({ ...current, fidelity }));
}
