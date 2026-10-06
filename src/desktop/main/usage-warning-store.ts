import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonConfig } from '../../core/config/json-config-write';
import { sameReset, type SubscriptionProvider, type UsageThresholdCrossing } from '../../core/pi-session/usage-thresholds';

const SCHEMA_VERSION = 1;
export const USAGE_WARNINGS_FILE = 'usage-warnings.json';
// A window id is provider text; a longer one is never recorded, so its warning shows once per launch.
export const MAX_WINDOW_ID_LENGTH = 100;

const PROVIDERS: ReadonlySet<unknown> = new Set<SubscriptionProvider>(['anthropic', 'openai']);

interface ShownWarning {
  readonly provider: SubscriptionProvider;
  readonly windowId: string;
  // epoch ms; the record is dropped once this passes
  readonly resetsAt: number;
  // the highest threshold shown for this window reset
  readonly threshold: UsageThresholdCrossing['threshold'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isWindowId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WINDOW_ID_LENGTH;
}

function parseWarning(raw: unknown): ShownWarning | undefined {
  if (!isRecord(raw)) return undefined;
  const provider = field(raw, 'provider');
  const windowId = field(raw, 'windowId');
  const resetsAt = field(raw, 'resetsAt');
  const threshold = field(raw, 'threshold');
  if (!PROVIDERS.has(provider) || !isWindowId(windowId)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || (threshold !== 80 && threshold !== 95)) return undefined;
  return { provider: provider as SubscriptionProvider, windowId, resetsAt, threshold };
}

function parseWarnings(text: string, log: (line: string) => void): ShownWarning[] {
  const parsed = JSON.parse(text) as unknown;
  const warnings = isRecord(parsed) && field(parsed, 'version') === SCHEMA_VERSION ? field(parsed, 'warnings') : undefined;
  if (!Array.isArray(warnings)) throw new Error('unknown schema');
  const valid = (warnings as unknown[]).flatMap((raw) => parseWarning(raw) ?? []);
  if (valid.length < warnings.length) log(`[usage-warnings] dropping ${warnings.length - valid.length} malformed records`);
  return valid;
}

function sameWindow(warning: ShownWarning, crossing: UsageThresholdCrossing): boolean {
  return warning.provider === crossing.provider && warning.windowId === crossing.windowId;
}

/**
 * The usage warnings the desktop showed (D54), one record per provider window, kept under userData until that window
 * resets, so a warning shown before a restart is not shown after it. A window with no reset time is never recorded:
 * nothing says when its record would expire, and core re-arms it within the run.
 */
export class UsageWarningStore {
  private readonly filePath: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private warnings: readonly ShownWarning[] = [];

  constructor(userDataDir: string, log: (line: string) => void, now: () => number = Date.now) {
    this.filePath = path.join(userDataDir, USAGE_WARNINGS_FILE);
    this.log = log;
    this.now = now;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    // An unreadable file records nothing; the next warning shown rewrites it.
    try {
      this.warnings = this.unexpired(parseWarnings(text, log));
    } catch (err) {
      log(`[usage-warnings] ignoring ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether this window reset's warning at this threshold, or a higher one, was shown. */
  shown(crossing: UsageThresholdCrossing): boolean {
    const { resetsAt } = crossing;
    if (resetsAt === undefined) return false;
    return this.warnings.some((warning) => sameWindow(warning, crossing) && sameReset(warning.resetsAt, resetsAt) && warning.threshold >= crossing.threshold);
  }

  /** Records a shown warning, replacing its window's earlier record and dropping every expired one; never rejects. */
  async record(crossing: UsageThresholdCrossing): Promise<void> {
    const { provider, windowId, threshold, resetsAt } = crossing;
    if (resetsAt === undefined || !isWindowId(windowId) || this.shown(crossing)) return;
    let next = this.warnings;
    try {
      await writeJsonConfig(this.filePath, () => {
        next = [...this.unexpired(this.warnings).filter((warning) => !sameWindow(warning, crossing)), { provider, windowId, resetsAt, threshold }];
        return `${JSON.stringify({ version: SCHEMA_VERSION, warnings: next }, null, 2)}\n`;
      });
    } catch (err) {
      this.log(`[usage-warnings] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Memory changes only once the write has landed (docs/invariants.md, "Desktop stores").
    this.warnings = next;
  }

  private unexpired(warnings: readonly ShownWarning[]): ShownWarning[] {
    const now = this.now();
    return warnings.filter((warning) => warning.resetsAt > now);
  }
}
