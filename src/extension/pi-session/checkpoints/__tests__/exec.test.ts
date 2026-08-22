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

/**
 * The optional timeout. Real processes throughout: the property under test is what happens to a child
 * that outlives its budget, and a fake timer proves nothing about a kill.
 *
 * `process.execPath` is the node running this suite, so every helper process is portable.
 */
describe('exec timeout', () => {
  /** A node process that stays alive for `ms` without producing output. */
  const idleFor = (ms: number): string[] => ['-e', `setTimeout(() => {}, ${ms})`];

  it('rejects a process that outlives its budget instead of resolving', async () => {
    await expect(exec(process.execPath, idleFor(30_000), undefined, undefined, 200)).rejects.toThrow();
  }, 10_000);

  it('names the timeout in the rejection, so the caller can log why it failed', async () => {
    // Callers of this path fail open on any rejection. The message is the only trace left of a wedged
    // filesystem, so it has to distinguish a timeout from git being missing.
    await expect(exec(process.execPath, idleFor(30_000), undefined, undefined, 200))
      .rejects.toThrow(/timed out after 200ms/);
  }, 10_000);

  it('does NOT resolve with the partial output a killed process managed to print', async () => {
    // Resolving here would hand the caller a truncated answer it cannot tell from a complete one.
    const partial = ['-e', 'process.stdout.write("half-an-answer"); setTimeout(() => {}, 30000)'];

    await expect(exec(process.execPath, partial, undefined, undefined, 300)).rejects.toThrow(/timed out/);
  }, 10_000);

  it('resolves normally when the process finishes inside the budget', async () => {
    const out = await exec(process.execPath, ['-e', 'process.stdout.write("done")'], undefined, undefined, 30_000);

    expect(out.stdout).toBe('done');
  }, 10_000);

  it('reports a non-zero exit as an exit, not as a timeout', async () => {
    const failing = ['-e', 'process.stderr.write("boom"); process.exit(3)'];

    await expect(exec(process.execPath, failing, undefined, undefined, 30_000))
      .rejects.toThrow(/exited with code 3/);
  }, 10_000);

  it('waits as long as the process runs when no timeout is passed', async () => {
    // The checkpoint engine passes nothing and must keep its old unbounded behavior.
    const slow = ['-e', 'setTimeout(() => process.stdout.write("late"), 300)'];

    const out = await exec(process.execPath, slow);

    expect(out.stdout).toBe('late');
  }, 10_000);

  it('leaves execSafe unbounded, since no checkpoint caller passes a timeout', async () => {
    const slow = ['-e', 'setTimeout(() => process.stdout.write("late"), 300)'];

    const result = await execSafe(process.execPath, slow);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stdout).toBe('late');
  }, 10_000);

  it('rejects from the timer rather than waiting for a close a grandchild holds open', async () => {
    // Killing the child does not close the stdio pipes while a grandchild still holds them, so a
    // rejection driven by `close` would never arrive. The child here spawns exactly that grandchild.
    // If this promise waited for `close` the test would hit its own 3 second limit, since the
    // grandchild outlives it.
    const holdsPipesOpen = [
      '-e',
      'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit" }); setTimeout(() => {}, 5000);',
    ];

    await expect(exec(process.execPath, holdsPipesOpen, undefined, undefined, 250))
      .rejects.toThrow(/timed out/);
  }, 3_000);
});
