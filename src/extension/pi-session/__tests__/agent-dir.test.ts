import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePiAgentDir } from '../agent-dir';

describe('ensurePiAgentDir (B3 + FR-9)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agentdir-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the dir + extensions subdir and seeds compaction off / images unblocked', () => {
    const agentDir = path.join(tmp, 'agent');
    const returned = ensurePiAgentDir(agentDir);

    expect(returned).toBe(agentDir);
    expect(fs.existsSync(path.join(agentDir, 'extensions'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.images.blockImages).toBe(false);
  });

  it('is idempotent — a second call does not rewrite the already-correct file', () => {
    const agentDir = path.join(tmp, 'agent');
    ensurePiAgentDir(agentDir);
    const first = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    ensurePiAgentDir(agentDir);
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe(first);
  });

  it('merges into existing settings without clobbering unrelated keys', () => {
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', compaction: { reserveTokens: 999, enabled: true } }),
    );

    ensurePiAgentDir(agentDir);

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.compaction.reserveTokens).toBe(999);
    expect(settings.images.blockImages).toBe(false);
  });
});
