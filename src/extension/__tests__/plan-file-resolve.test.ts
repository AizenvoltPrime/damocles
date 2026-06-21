import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-plan-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { findSessionPlanFiles, computePlanFilePath, DAMOCLES_PLANS_DIR } from '../paths';

function writePlan(filePath: string, mtime: Date): void {
  fs.writeFileSync(filePath, '# plan', 'utf-8');
  fs.utimesSync(filePath, mtime, mtime);
}

describe('findSessionPlanFiles', () => {
  beforeEach(() => {
    fs.rmSync(DAMOCLES_PLANS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DAMOCLES_PLANS_DIR, { recursive: true });
  });

  it('returns an empty list when no plan file exists for the session', async () => {
    expect(await findSessionPlanFiles('no-such-session')).toEqual([]);
  });

  it('finds a plan across slug drift — the pre-prompt fallback and the post-prompt slug share one suffix', async () => {
    // A plan bound before the first message lands at `plan-<id8>.md`; once the user prompts, the writer's
    // slug changes to `<slug>-<id8>.md`. Both must resolve for the same session, matched on the suffix.
    const id = 'session-drift';
    const orphan = computePlanFilePath(id, ''); // plan-<id8>.md
    const settled = computePlanFilePath(id, 'Add the feature'); // add-the-feature-<id8>.md
    expect(orphan).not.toBe(settled);
    writePlan(orphan, new Date('2020-01-01T00:00:00Z'));
    writePlan(settled, new Date('2021-01-01T00:00:00Z'));

    const found = await findSessionPlanFiles(id);
    expect([...found].sort()).toEqual([orphan, settled].sort());
    expect(found[0]).toBe(settled); // newest-mtime first
  });

  it('does not match another session whose id hashes to a different suffix', async () => {
    writePlan(computePlanFilePath('session-a', 'shared message'), new Date('2020-01-01T00:00:00Z'));
    writePlan(computePlanFilePath('session-b', 'shared message'), new Date('2020-01-01T00:00:00Z'));

    const found = await findSessionPlanFiles('session-a');
    expect(found).toEqual([computePlanFilePath('session-a', 'shared message')]);
  });
});
