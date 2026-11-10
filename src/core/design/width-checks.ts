// DesignCheck at widths (PD-14): each screen probed at the checked widths plus the overflow sweep, in the attached client's
// runner (PD-11), recorded per screen with its render inputs' hash in the state folder and the manifest.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DesignPreviewHost } from '../../platform/design-preview';
import { DESIGN_RENDER_CLIENT_ABSENT, MAX_QUEUED_RUNS_PER_AUTHORITY, MIN_RENDER_WIDTH } from '../../shared/design-render';
import type { DesignCheckIssue } from '../../shared/types/design';
import { widthIssues, type CheckedWidth } from './design-check';
import { designContentHash, updateManifest, type ManifestScreen } from './design-files';
import { renderInputHashes } from './render-inputs';
import { log } from '../logger';
import { designStateDirOf } from './design-paths';
import { checkedWidthsOf, designViewports } from './design-preview';
import { writeJsonAtomic } from './design-state';
import { withDesignWrite } from './design-writes';

export const WIDTH_CHECKS_DIR = 'checks';
const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** No client that renders designs is attached (PD-11). */
export class DesignRenderUnavailableError extends Error {
  constructor() {
    super(DESIGN_RENDER_CLIENT_ABSENT);
    this.name = 'DesignRenderUnavailableError';
  }
}

/**
 * `work` over `items`, at most MAX_QUEUED_RUNS_PER_AUTHORITY at once, so a call's runs fit one authority's queue in the app
 * even while another authority holds every running slot; the results in `items`' order.
 */
export async function inRenderBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += MAX_QUEUED_RUNS_PER_AUTHORITY) results.push(...await Promise.all(items.slice(start, start + MAX_QUEUED_RUNS_PER_AUTHORITY).map(work)));
  return results;
}

/** A render request through `render`, with the daemon's refusal turned into DesignRenderUnavailableError. */
export async function rendered<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message === DESIGN_RENDER_CLIENT_ABSENT) throw new DesignRenderUnavailableError();
    throw err;
  }
}

/** `checks/<screen>.json`: one screen's width check at its render inputs' hash. */
export interface WidthCheckRecord {
  readonly schemaVersion: 1;
  readonly screen: string;
  readonly file: string;
  readonly screenHash: string;
  /** The folder's content hash when the check ran, which the manifest's `widthCheck` names. */
  readonly contentHash: string;
  /** The screen's `renderInputHashes` entry, which a later check reuses the record at. */
  readonly renderHash: string;
  readonly widths: readonly CheckedWidth[];
  readonly sweepTo: number;
  readonly issues: readonly DesignCheckIssue[];
  readonly consoleErrors: readonly string[];
  readonly checkedAt: string;
  /** The screen's latest PreviewJourney, which the width check keeps when it rewrites the record. */
  readonly journey?: JourneyCheckRecord;
}

/** A PreviewJourney run as `checks/<screen>.json` records it, beside the width check. */
export interface JourneyCheckRecord {
  /** The screen file's SHA-256 the run loaded. */
  readonly screenHash: string;
  readonly state: string;
  readonly passed: boolean;
  /** Per width, the index of the step that failed, null when the run passed. */
  readonly results: readonly { readonly width: number; readonly passed: boolean; readonly failedStep: number | null }[];
  readonly untested: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly ranAt: string;
}

export interface WidthCheckScreen {
  readonly id: string;
  /** Relative to the design folder. */
  readonly file: string;
  readonly contentHash: string;
}

export interface WidthCheckResult {
  readonly widths: readonly CheckedWidth[];
  readonly issues: readonly DesignCheckIssue[];
}

/** The record's file: the screen file's stem when it is a plain name, else a hash of the file's path. */
function recordFile(stateDir: string, screenFile: string): string {
  const stem = path.posix.basename(screenFile).replace(/\.html$/i, '');
  const name = RECORD_NAME.test(stem) ? stem : createHash('sha256').update(screenFile).digest('hex').slice(0, 16);
  return path.join(stateDir, WIDTH_CHECKS_DIR, `${name}.json`);
}

async function readRawRecord(file: string): Promise<Partial<WidthCheckRecord> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let value: Partial<WidthCheckRecord> | null;
  try {
    value = JSON.parse(text) as Partial<WidthCheckRecord> | null;
  } catch (err) {
    log('[WidthChecks] %s is not JSON, so the screen has no width check: %O', file, err);
    return undefined;
  }
  return value?.schemaVersion === 1 ? value : undefined;
}

// A record that holds only a journey has no width check yet.
const widthRecordOf = (value: Partial<WidthCheckRecord> | undefined): WidthCheckRecord | undefined =>
  value && typeof value.renderHash === 'string' && Array.isArray(value.issues) && Array.isArray(value.widths) ? value as WidthCheckRecord : undefined;

/** Records a PreviewJourney run in the screen's `checks/<screen>.json`, keeping its width check. */
export function recordJourneyCheck(designId: string, screen: WidthCheckScreen, journey: JourneyCheckRecord): Promise<void> {
  const stateDir = designStateDirOf(designId);
  const file = recordFile(stateDir, screen.file);
  return withDesignWrite(stateDir, async () => {
    const held = await readRawRecord(file);
    await writeJsonAtomic(file, held?.file === screen.file ? { ...held, journey } : { schemaVersion: 1, screen: screen.id, file: screen.file, journey });
  });
}

/** Removes screen file `file`'s `checks/<screen>.json`, if any, a cache the next check rebuilds. */
export function removeCheckRecord(designId: string, file: string): Promise<void> {
  const stateDir = designStateDirOf(designId);
  return withDesignWrite(stateDir, () => fs.rm(recordFile(stateDir, file), { force: true }));
}

const sameWidths = (a: readonly CheckedWidth[], b: readonly CheckedWidth[]): boolean => a.length === b.length && a.every((width, index) => width.width === b[index]?.width);

/**
 * Probes every screen at the checked widths, with the sweep from 320 px to the widest breakpoint or checked width.
 * `reuse`: a screen whose record holds its current render inputs' hash, the same widths and the same sweep is not probed again.
 */
export async function runWidthChecks(input: {
  readonly designId: string;
  readonly folder: string;
  readonly screens: readonly WidthCheckScreen[];
  readonly render: DesignPreviewHost;
  readonly reuse: boolean;
  readonly signal: AbortSignal;
}): Promise<WidthCheckResult> {
  const viewports = await designViewports(input.folder);
  const widths = checkedWidthsOf(viewports);
  const sweepTo = Math.max(MIN_RENDER_WIDTH, ...viewports.breakpoints.map((breakpoint) => breakpoint.width), ...widths.map((checked) => checked.width));
  const contentHash = await designContentHash(input.folder);
  const renderHashes = await renderInputHashes(input.folder, input.screens.map((screen) => screen.file));
  const stateDir = designStateDirOf(input.designId);
  // one screen's failure ends the other screens' runs
  const run = new AbortController();
  const signal = AbortSignal.any([input.signal, run.signal]);
  const records = await inRenderBatches(input.screens, async (screen): Promise<WidthCheckRecord> => {
    const file = recordFile(stateDir, screen.file);
    const raw = await readRawRecord(file);
    const renderHash = renderHashes[screen.file]!;
    const held = input.reuse ? widthRecordOf(raw) : undefined;
    if (held && held.renderHash === renderHash && held.file === screen.file && held.sweepTo === sweepTo && sameWidths(held.widths, widths)) return held;
    const probe = await rendered(() => input.render.probe(input.designId, screen.file, widths.map((checked) => checked.width), null, sweepTo, signal));
    const record: WidthCheckRecord = {
      schemaVersion: 1,
      screen: screen.id,
      file: screen.file,
      screenHash: screen.contentHash,
      contentHash,
      renderHash,
      widths,
      sweepTo,
      issues: widthIssues(screen.id, probe, widths),
      consoleErrors: [...probe.consoleErrors],
      checkedAt: new Date().toISOString(),
    };
    // a PreviewJourney that recorded while the probe ran keeps its journey
    return withDesignWrite(stateDir, async () => {
      const latest = await readRawRecord(file);
      const kept: WidthCheckRecord = { ...record, ...(latest?.file === screen.file && latest.journey ? { journey: latest.journey } : {}) };
      await writeJsonAtomic(file, kept);
      return kept;
    });
  }).finally(() => run.abort(new Error('The width check of another screen failed')));
  await updateManifest(input.folder, input.designId, (current) => ({
    ...current,
    screens: current.screens.map((screen): ManifestScreen => {
      const record = records.find((candidate) => candidate.file === screen.file);
      if (!record) return screen;
      const errors = record.issues.filter((issue) => issue.severity === 'error').length;
      return { ...screen, widthCheck: { contentHash, widths: widths.map((checked) => checked.width), errors, warnings: record.issues.length - errors } };
    }),
  }));
  return { widths, issues: records.flatMap((record) => record.issues) };
}
