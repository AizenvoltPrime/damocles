import * as fs from 'fs';
import * as path from 'path';
import { renameWithRetry } from '../config/json-config-write';
import { log } from '../logger';
import type { TeamCheckpoint } from './types';

// `<key>.json.<pid>.tmp`, and `<key>.json.tmp` from writers that named no pid.
const STALE_TEMP = /^\d+\.json(?:\.\d+)?\.tmp$/;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The checkpoint's JSON with `asOf` left out, so a snapshot that only re-stamps its time compares as unchanged,
 * and the file's JSON, which carries `asOf` last. One serialization serves both.
 */
function serialize(checkpoint: TeamCheckpoint): { comparable: string; file: string } {
  const { asOf, ...rest } = checkpoint;
  const comparable = JSON.stringify(rest);
  return { comparable, file: asOf === undefined ? comparable : `${comparable.slice(0, -1)},"asOf":${asOf}}` };
}

/**
 * Writes one run's team checkpoint: live snapshots until a stop seals it. At most one write is in flight and
 * one pending, and a write takes its content when it starts, so a burst of changes lands once with the latest state.
 * Failures go to `onError`; nothing here throws into the team.
 */
export class CheckpointWriter {
  private readonly filePath: string;
  private readonly snapshot: () => TeamCheckpoint;
  private readonly onError: (err: Error) => void;
  private sealed: TeamCheckpoint | null = null;
  // Set by the first seal, built or not: from then on live schedules write nothing.
  private stopped = false;
  // The latest seal's content could not be built, so the latest content is not on disk.
  private sealUnbuilt = false;
  private inFlight: Promise<void> | null = null;
  private pending = false;
  private written: string | null = null;
  // Nothing requested counts as landed.
  private landed = true;
  private opened = false;

  constructor(options: { filePath: string; snapshot: () => TeamCheckpoint; onError: (err: Error) => void }) {
    this.filePath = options.filePath;
    this.snapshot = options.snapshot;
    this.onError = options.onError;
  }

  schedule(): void {
    if (!this.stopped) this.request();
  }

  /**
   * Builds the sealed content now and writes it; each call replaces the sealed content, and once sealed, live
   * schedules write nothing. A build that throws is reported, and the content already on disk stays. Returns
   * what was sealed, or null when the build threw.
   */
  seal(build: () => TeamCheckpoint): TeamCheckpoint | null {
    this.stopped = true;
    let content: TeamCheckpoint;
    try {
      content = { ...build() };
    } catch (err) {
      this.sealUnbuilt = true;
      this.onError(asError(err));
      return null;
    }
    delete content.live;
    this.sealUnbuilt = false;
    this.sealed = content;
    this.request();
    return content;
  }

  /** True when the latest content is on disk, which it is when nothing was ever requested. */
  async flush(): Promise<boolean> {
    while (this.inFlight) await this.inFlight;
    return this.landed && !this.sealUnbuilt;
  }

  /** Whether any content reached disk, so a later failed write still leaves a checkpoint a resume can read. */
  get hasLanded(): boolean {
    return this.written !== null;
  }

  private request(): void {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = this.drain();
  }

  private async drain(): Promise<void> {
    // A synchronous change (a bus send reaching every inbox) completes before the snapshot is taken.
    await Promise.resolve();
    do {
      this.pending = false;
      await this.writeLatest();
    } while (this.pending);
    this.inFlight = null;
  }

  private async writeLatest(): Promise<void> {
    // A stop whose seal could not be built leaves the last live snapshot, never a later one.
    if (this.stopped && this.sealed === null) return;
    let content: TeamCheckpoint;
    try {
      content = this.sealed ?? this.snapshot();
    } catch (err) {
      this.landed = false;
      this.onError(asError(err));
      return;
    }
    const body = serialize(content);
    if (body.comparable === this.written) {
      // The disk already holds this content, whatever an attempt in between failed to write.
      this.landed = true;
      return;
    }
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      if (!this.opened) await this.open();
      await fs.promises.writeFile(temp, body.file);
      await renameWithRetry(temp, this.filePath);
      this.written = body.comparable;
      this.landed = true;
    } catch (err) {
      this.landed = false;
      this.onError(asError(err));
      await fs.promises.rm(temp, { force: true }).catch((rmErr: unknown) => this.onError(asError(rmErr)));
    }
  }

  /**
   * Only the first write creates the folder, so a write that outlives a delete fails instead of recreating it.
   * A stale temp left by a crashed write is removed; one that cannot be removed is logged and never blocks the write.
   */
  private async open(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    this.opened = true;
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      log('[CheckpointWriter] listing %s for stale temp files failed: %O', dir, err);
      return;
    }
    for (const name of names.filter((n) => STALE_TEMP.test(n))) {
      await fs.promises.rm(path.join(dir, name), { force: true })
        .catch((err: unknown) => log('[CheckpointWriter] removing the stale temp file %s failed: %O', name, err));
    }
  }
}
