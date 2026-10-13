import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CHARS, STATUS_LIMIT } from '../../../core/scm/repository';
import { MAX_COMMIT_MESSAGE_CHARS, SCM_STATUS_LIMIT } from '../../preload/scm-channels';

describe('source control bounds shared by core and the preload validators', () => {
  it('match, since core cannot import the preload', () => {
    expect(MAX_COMMIT_MESSAGE_CHARS).toBe(MAX_MESSAGE_CHARS);
    expect(SCM_STATUS_LIMIT).toBe(STATUS_LIMIT);
  });
});
