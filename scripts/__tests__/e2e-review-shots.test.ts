import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../e2e/desktop/support/hermetic';
import { outsideRepository } from '../../e2e/remote/support/review-shots';

describe('the remote suite\'s review captures', () => {
  it('go only to an absolute folder outside the repository', () => {
    expect(outsideRepository(path.join(os.tmpdir(), 'damocles-shots'))).toBe(true);
    expect(outsideRepository(path.join(REPO_ROOT, 'test-results', 'shots'))).toBe(false);
    expect(outsideRepository(REPO_ROOT)).toBe(false);
    // a folder inside whose name starts with two dots is still inside
    expect(outsideRepository(path.join(REPO_ROOT, '..shots'))).toBe(false);
    expect(outsideRepository('shots')).toBe(false);
  });
});
