import { describe, it, expect } from 'vitest';
import { exec, execSafe } from '../exec';

describe('exec', () => {
  it('resolves with stdout for a successful command', async () => {
    const out = await exec('git', ['--version']);
    expect(out.stdout).toContain('git version');
  });

  it('rejects when the command exits non-zero', async () => {
    await expect(exec('git', ['rev-parse', '--verify', 'definitely-not-a-ref'])).rejects.toThrow();
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(exec('damocles-no-such-binary-xyz', ['--help'])).rejects.toThrow();
  });
});

describe('execSafe', () => {
  it('returns ok:true with output on success', async () => {
    const result = await execSafe('git', ['--version']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stdout).toContain('git version');
  });

  it('returns ok:false with an error string on failure', async () => {
    const result = await execSafe('damocles-no-such-binary-xyz', ['--help']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });

  it('never throws even for a non-zero exit', async () => {
    const result = await execSafe('git', ['rev-parse', '--verify', 'nope-nope-nope']);
    expect(result.ok).toBe(false);
  });
});
