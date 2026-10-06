import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageThresholdCrossing } from '../../../core/pi-session/usage-thresholds';
import { MAX_WINDOW_ID_LENGTH, USAGE_WARNINGS_FILE, UsageWarningStore } from '../usage-warning-store';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

let userData: string;
let lines: string[];
let now: number;

function store(): UsageWarningStore {
  return new UsageWarningStore(userData, (line) => lines.push(line), () => now);
}

function crossing(overrides: Partial<UsageThresholdCrossing> = {}): UsageThresholdCrossing {
  return { provider: 'anthropic', windowId: 'five_hour', windowLabel: 'Session (5hr)', threshold: 80, utilization: 82, resetsAt: NOW + 2 * HOUR, ...overrides };
}

function onDisk(): unknown {
  return JSON.parse(fs.readFileSync(path.join(userData, USAGE_WARNINGS_FILE), 'utf8'));
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-usage-warnings-'));
  lines = [];
  now = NOW;
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('UsageWarningStore (D54)', () => {
  it('remembers a warning shown before a restart, at its threshold and below, for that window reset only', async () => {
    await store().record(crossing());
    const restarted = store();
    expect(restarted.shown(crossing())).toBe(true);
    // The provider reports a reset time that jitters by seconds between refreshes.
    expect(restarted.shown(crossing({ resetsAt: NOW + 2 * HOUR + 20_000 }))).toBe(true);
    expect(restarted.shown(crossing({ threshold: 95, utilization: 96 }))).toBe(false);
    expect(restarted.shown(crossing({ windowId: 'seven_day' }))).toBe(false);
    expect(restarted.shown(crossing({ provider: 'openai' }))).toBe(false);

    await restarted.record(crossing({ threshold: 95, utilization: 96 }));
    expect(store().shown(crossing())).toBe(true);
    expect(store().shown(crossing({ threshold: 95, utilization: 97 }))).toBe(true);
  });

  it('shows a window\'s warning again once it resets, and keeps one record per window', async () => {
    await store().record(crossing());
    now = NOW + 3 * HOUR;
    const later = crossing({ resetsAt: NOW + 7 * HOUR });
    const restarted = store();
    expect(restarted.shown(later)).toBe(false);
    await restarted.record(later);
    expect(onDisk()).toEqual({ version: 1, warnings: [{ provider: 'anthropic', windowId: 'five_hour', resetsAt: NOW + 7 * HOUR, threshold: 80 }] });
    expect(store().shown(later)).toBe(true);
  });

  it('drops every record whose reset has passed, from memory at once and from the file at the next write', async () => {
    const recorder = store();
    await recorder.record(crossing());
    await recorder.record(crossing({ windowId: 'seven_day', windowLabel: 'Weekly', resetsAt: NOW + 100 * HOUR }));
    now = NOW + 3 * HOUR;
    const restarted = store();
    expect(restarted.shown(crossing())).toBe(false);
    await restarted.record(crossing({ provider: 'openai', windowId: 'codex_primary' }));
    expect(onDisk()).toEqual({
      version: 1,
      warnings: [
        { provider: 'anthropic', windowId: 'seven_day', resetsAt: NOW + 100 * HOUR, threshold: 80 },
        { provider: 'openai', windowId: 'codex_primary', resetsAt: NOW + 2 * HOUR, threshold: 80 },
      ],
    });
  });

  it('never records a window with no reset time or an over-long id', async () => {
    const recorder = store();
    const { resetsAt: _resetsAt, ...noReset } = crossing();
    await recorder.record(noReset);
    await recorder.record(crossing({ windowId: 'x'.repeat(MAX_WINDOW_ID_LENGTH + 1) }));
    expect(fs.existsSync(path.join(userData, USAGE_WARNINGS_FILE))).toBe(false);
    expect(recorder.shown(noReset)).toBe(false);
  });

  it('logs and ignores a corrupt file, drops malformed records, and rewrites the file on the next warning', async () => {
    const file = path.join(userData, USAGE_WARNINGS_FILE);
    fs.writeFileSync(file, '{"version": 1, "warnings": [');
    const fresh = store();
    expect(lines).toEqual([expect.stringMatching(/^\[usage-warnings\] ignoring .*usage-warnings\.json: /)]);
    expect(fresh.shown(crossing())).toBe(false);
    await fresh.record(crossing());
    expect(store().shown(crossing())).toBe(true);

    lines = [];
    fs.writeFileSync(file, JSON.stringify({ version: 1, warnings: [
      { provider: 'anthropic', windowId: 'five_hour', resetsAt: NOW + HOUR, threshold: 80 },
      { provider: 'mystery', windowId: 'five_hour', resetsAt: NOW + HOUR, threshold: 80 },
      { provider: 'openai', windowId: '', resetsAt: NOW + HOUR, threshold: 80 },
      { provider: 'openai', windowId: 'codex_primary', resetsAt: 'soon', threshold: 80 },
      { provider: 'openai', windowId: 'codex_primary', resetsAt: NOW + HOUR, threshold: 50 },
    ] }));
    const filtered = store();
    expect(lines).toEqual(['[usage-warnings] dropping 4 malformed records']);
    expect(filtered.shown(crossing({ resetsAt: NOW + HOUR }))).toBe(true);
    expect(filtered.shown(crossing({ provider: 'openai', windowId: 'codex_primary', resetsAt: NOW + HOUR }))).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ version: 2, warnings: [] }));
    lines = [];
    store();
    expect(lines).toEqual([expect.stringContaining('unknown schema')]);
  });
});
