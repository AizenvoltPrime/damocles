import { describe, expect, it } from 'vitest';
import { FILE_DRAG_MIME, parseFileDragPayload, parseFileDragTarget, serializeFileDragPayload } from '../file-drag';

describe('file drag payload', () => {
  it('round-trips a project key and relative path under its own MIME type', () => {
    expect(FILE_DRAG_MIME).toBe('application/x-damocles-file');
    const text = serializeFileDragPayload({ projectKey: 'c:\\proj', relativePath: 'src/a.ts' });
    expect(parseFileDragPayload(text)).toEqual({ projectKey: 'c:\\proj', relativePath: 'src/a.ts' });
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['a missing key', JSON.stringify({ relativePath: 'a' })],
    ['an escaping path', JSON.stringify({ projectKey: 'p', relativePath: '../a' })],
    ['an absolute path', JSON.stringify({ projectKey: 'p', relativePath: '/etc/passwd' })],
    ['a drive path', JSON.stringify({ projectKey: 'p', relativePath: 'C:x' })],
    ['a backslash path', JSON.stringify({ projectKey: 'p', relativePath: 'a\\b' })],
    ['an overlong key', JSON.stringify({ projectKey: 'k'.repeat(201), relativePath: 'a' })],
    ['an overlong payload', 'x'.repeat(16 * 1024 + 1)],
  ])('refuses %s', (_name, raw) => {
    expect(parseFileDragPayload(raw)).toBeUndefined();
  });

  it('takes the two fields of a message as they are, and refuses any other value without throwing', () => {
    expect(parseFileDragTarget('c:\\proj', 'src/a.ts')).toEqual({ projectKey: 'c:\\proj', relativePath: 'src/a.ts' });
    for (const [projectKey, relativePath] of [[1n, 'a.ts'], ['p', 1n], ['', 'a.ts'], ['p', '../a'], ['k'.repeat(201), 'a'], [{}, 'a']] as const) {
      expect(parseFileDragTarget(projectKey, relativePath)).toBeUndefined();
    }
  });
});
