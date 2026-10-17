import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_COMMENT_CHARS, MAX_REVIEW_COMMENTS, parseReviewDrafts, parseReviewFileDiff, parseReviewRef, parseReviewScope } from '../../preload/review-channels';
import { MAX_SCM_RANGES, parseScmMergeFile, parseScmPath, parseScmResource, parseScmRun, parseScmTimeline, parseScmTimelineCursor } from '../../preload/scm-channels';

const HASH = 'a'.repeat(40);
const range = (os: number, oe: number, ms: number, me: number) => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });
const stage = (ranges: unknown, extra: Record<string, unknown> = {}) => ({ op: 'stageRanges', repoId: 'repo-1', path: 'src/a.ts', documentId: 'doc-1', ranges, indexOid: HASH, ...extra });

describe('editor git requests', () => {
  it('takes stage and unstage ranges with exactly their fields, well formed and in order on the side applied', () => {
    expect(parseScmRun(stage([range(1, 1, 1, 1), range(3, 0, 4, 5)]))).toEqual(stage([range(1, 1, 1, 1), range(3, 0, 4, 5)]));
    expect(parseScmRun(stage([range(1, 1, 1, 1)], { extra: true }))).toBeUndefined();
    expect(parseScmRun(stage([]))).toBeUndefined();
    expect(parseScmRun(stage([range(3, 3, 3, 3), range(1, 1, 1, 1)]))).toBeUndefined();
    expect(parseScmRun(stage([range(2, 2, 2, 2), range(2, 2, 3, 3)]))).toBeUndefined();
    expect(parseScmRun(stage([range(1, 0, 2, 0)]))).toBeUndefined();
    expect(parseScmRun(stage([range(3, 2, 1, 1)]))).toBeUndefined();
    expect(parseScmRun(stage([{ ...range(1, 1, 1, 1), more: 1 }]))).toBeUndefined();
    expect(parseScmRun(stage(Array.from({ length: MAX_SCM_RANGES + 1 }, (_value, index) => range(index + 1, index + 1, index + 1, index + 1))))).toBeUndefined();
    expect(parseScmRun(stage([range(1, 1, 1, 1)], { indexOid: 'HEAD' }))).toBeUndefined();
    expect(parseScmRun(stage([range(1, 1, 1, 1)], { path: '../x' }))).toBeUndefined();
    // an unstage is applied inverted onto the index, so its order is the index side's
    expect(parseScmRun(stage([range(5, 5, 1, 1), range(1, 1, 3, 3)], { op: 'unstageRanges', headOid: HASH }))).toBeDefined();
    expect(parseScmRun(stage([range(1, 1, 3, 3), range(5, 5, 1, 1)], { op: 'unstageRanges', headOid: HASH }))).toBeUndefined();
  });

  it('takes an unstage only with the HEAD blob its ranges were computed against, null when HEAD lacks the file', () => {
    const unstage = (extra: Record<string, unknown>) => stage([range(1, 1, 1, 1)], { op: 'unstageRanges', ...extra });
    expect(parseScmRun(unstage({ headOid: HASH }))).toEqual(unstage({ headOid: HASH }));
    expect(parseScmRun(unstage({ headOid: null }))).toEqual(unstage({ headOid: null }));
    expect(parseScmRun(unstage({}))).toBeUndefined();
    expect(parseScmRun(unstage({ headOid: 'HEAD' }))).toBeUndefined();
    expect(parseScmRun(stage([range(1, 1, 1, 1)], { headOid: HASH }))).toBeUndefined();
  });

  it('takes the merge, commit, timeline and compare runs with exactly their fields', () => {
    expect(parseScmRun({ op: 'completeMerge', repoId: 'r', path: 'c.txt', documentId: 'd' })).toEqual({ op: 'completeMerge', repoId: 'r', path: 'c.txt', documentId: 'd' });
    expect(parseScmRun({ op: 'openCommit', repoId: 'r', commit: HASH })).toEqual({ op: 'openCommit', repoId: 'r', commit: HASH });
    expect(parseScmRun({ op: 'openCommit', repoId: 'r', commit: HASH, path: 'a.txt' })).toEqual({ op: 'openCommit', repoId: 'r', commit: HASH, path: 'a.txt' });
    expect(parseScmRun({ op: 'openCommit', repoId: 'r', commit: 'main' })).toBeUndefined();
    expect(parseScmRun({ op: 'openTimeline', repoId: 'r', path: 'a.txt' })).toEqual({ op: 'openTimeline', repoId: 'r', path: 'a.txt' });
    expect(parseScmRun({ op: 'openMergeEditor', repoId: 'r', path: 'a.txt', extra: 1 })).toBeUndefined();
    const file = { commit: HASH, path: 'a.txt' };
    expect(parseScmRun({ op: 'compareCommits', repoId: 'r', left: file, right: { commit: 'b'.repeat(64), path: 'old/a.txt' } })).toBeDefined();
    expect(parseScmRun({ op: 'compareCommits', repoId: 'r', left: file, right: { commit: HASH } })).toBeUndefined();
  });

  it('takes the reads with exactly their fields', () => {
    expect(parseScmPath({ repoId: 'r', path: 'a.txt' })).toEqual({ repoId: 'r', path: 'a.txt' });
    expect(parseScmPath({ repoId: 'r', path: '/abs' })).toBeUndefined();
    expect(parseScmMergeFile({ repoId: 'r', path: 'a.txt', diff3: true })).toEqual({ repoId: 'r', path: 'a.txt', diff3: true });
    expect(parseScmMergeFile({ repoId: 'r', path: 'a.txt', diff3: 'yes' })).toBeUndefined();
    expect(parseScmResource({ projectKey: 'p', relativePath: 'src/a.ts' })).toEqual({ projectKey: 'p', relativePath: 'src/a.ts' });
    expect(parseScmTimeline({ repoId: 'r', path: 'a.txt' })).toEqual({ repoId: 'r', path: 'a.txt' });
    expect(parseScmTimeline({ repoId: 'r', path: 'a.txt', cursor: `${HASH}:old/a.txt` })).toEqual({ repoId: 'r', path: 'a.txt', cursor: `${HASH}:old/a.txt` });
    expect(parseScmTimeline({ repoId: 'r', path: 'a.txt', cursor: '50' })).toBeUndefined();
    expect(parseScmTimelineCursor(`${HASH}:old/b.txt`)).toEqual({ hash: HASH, path: 'old/b.txt' });
    expect(parseScmTimelineCursor(`${HASH}:../x`)).toBeUndefined();
  });
});

describe('chat review requests', () => {
  const comment = { path: 'src/a.ts', line: 3, side: 'added', scope: 'chat', text: 'Rename this', revision: '0123abcd' };

  it('takes drafts within the bounds, each with exactly its fields', () => {
    expect(parseReviewDrafts({ reviewId: 'r', comments: [comment] })).toEqual({ reviewId: 'r', comments: [comment] });
    expect(parseReviewDrafts({ reviewId: 'r', comments: [] })).toEqual({ reviewId: 'r', comments: [] });
    expect(parseReviewDrafts({ reviewId: 'r', comments: Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => comment) })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, text: 'x'.repeat(MAX_REVIEW_COMMENT_CHARS + 1) }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, text: '   ' }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, line: 0 }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, side: 'both' }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, quoted: 'forged' }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, path: 'a\nb' }] })).toBeUndefined();
    // the revision is hex within its bound, and required
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, revision: 'XYZ' }] })).toBeUndefined();
    expect(parseReviewDrafts({ reviewId: 'r', comments: [{ ...comment, revision: 'a'.repeat(65) }] })).toBeUndefined();
    const { revision: _revision, ...unrevised } = comment;
    expect(parseReviewDrafts({ reviewId: 'r', comments: [unrevised] })).toBeUndefined();
  });

  it('takes the other review requests with exactly their fields', () => {
    expect(parseReviewRef({ reviewId: 'r' })).toEqual({ reviewId: 'r' });
    expect(parseReviewRef({ reviewId: '' })).toBeUndefined();
    expect(parseReviewScope({ reviewId: 'r', scope: 'turn' })).toEqual({ reviewId: 'r', scope: 'turn' });
    expect(parseReviewScope({ reviewId: 'r', scope: 'all' })).toBeUndefined();
    expect(parseReviewFileDiff({ reviewId: 'r', path: 'src/a.ts' })).toEqual({ reviewId: 'r', path: 'src/a.ts' });
    expect(parseReviewFileDiff({ reviewId: 'r', path: 'src/a.ts', scope: 'chat' })).toBeUndefined();
  });
});
