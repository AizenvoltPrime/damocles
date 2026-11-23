// A header check that throws anything is a blob main does not serve: the guard has no third outcome.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { thrown, lines, failing } = vi.hoisted(() => {
  const state = { on: false };
  return {
    thrown: state,
    lines: [] as string[],
    failing: <A extends unknown[], R>(real: (...args: A) => R) => (...args: A): R => {
      if (state.on) throw new RangeError('Offset is outside the bounds of the DataView');
      return real(...args);
    },
  };
});
vi.mock('../../../../shared/themes/image-header', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/themes/image-header')>();
  return { ...actual, readImageHeader: failing(actual.readImageHeader) };
});
vi.mock('../../../../shared/themes/video-header', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/themes/video-header')>();
  return { ...actual, readVideoHeader: failing(actual.readVideoHeader) };
});
vi.mock('../../../../core/themes/sprite-header', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/themes/sprite-header')>();
  return { ...actual, isDeclaredSprite: failing(actual.isDeclaredSprite) };
});
vi.mock('../../../../core/logger', () => ({ log: (line: string) => lines.push(line) }));

import { isDeclaredAnimation, isDeclaredImage, isDeclaredVideo, openThemeBlob, readThemeBlob } from '../theme-blobs';
import { gif, png } from '../../../../shared/themes/testing/image-fixtures';
import { mp4 } from '../../../../core/themes/__tests__/video-fixtures';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-blobs-closed-'));
  fs.mkdirSync(path.join(root, 'blobs'));
  for (const bytes of [png(64, 64), gif(64, 64, 2), mp4(), png(32, 32)]) fs.writeFileSync(path.join(root, 'blobs', sha(bytes)), bytes);
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  thrown.on = false;
  lines.length = 0;
});

describe('a header check that throws', () => {
  it('answers that the bytes are not the declared type, and says so in the log', () => {
    expect(isDeclaredImage(png(64, 64), 'image/png')).toBe(true);
    expect(isDeclaredAnimation(gif(64, 64, 2), 'image/gif')).toBe(true);
    expect(isDeclaredVideo(mp4(), 'video/mp4')).toBe(true);
    expect(lines).toEqual([]);
    thrown.on = true;
    expect(isDeclaredImage(png(64, 64), 'image/png')).toBe(false);
    expect(isDeclaredAnimation(gif(64, 64, 2), 'image/gif')).toBe(false);
    expect(isDeclaredVideo(mp4(), 'video/mp4')).toBe(false);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.includes('Offset is outside the bounds of the DataView'))).toBe(true);
  });

  it('serves no image, animation, video or sprite whose check threw', async () => {
    const sprite = sha(png(32, 32));
    expect(await readThemeBlob(root, sprite, () => ({ kind: 'sprite', mime: 'image/png' }))).toBeDefined();
    thrown.on = true;
    expect(await readThemeBlob(root, sha(png(64, 64)), () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
    expect(await readThemeBlob(root, sha(gif(64, 64, 2)), () => ({ kind: 'animated', mime: 'image/gif' }))).toBeUndefined();
    expect(await openThemeBlob(root, sha(mp4()), () => ({ kind: 'video', mime: 'video/mp4' }))).toBeUndefined();
    expect(await readThemeBlob(root, sprite, () => ({ kind: 'sprite', mime: 'image/png' }))).toBeUndefined();
    expect(lines).toHaveLength(4);
  });

  it('says nothing for bytes that are plainly another type', () => {
    expect(isDeclaredImage(new Uint8Array(64), 'image/png')).toBe(false);
    expect(isDeclaredVideo(new Uint8Array(64), 'video/mp4')).toBe(false);
    expect(lines).toEqual([]);
  });
});
