import { describe, it, expect } from 'vitest';
import { IMAGE_MEDIA_TYPES, isImageBlock } from '../types/content';

const image = (source: unknown) => ({ type: 'image', source });

describe('isImageBlock', () => {
  it.each(IMAGE_MEDIA_TYPES)('accepts a base64 %s block', (mediaType) => {
    expect(isImageBlock(image({ type: 'base64', media_type: mediaType, data: 'AAAA' }))).toBe(true);
  });

  it.each([
    ['empty data', image({ type: 'base64', media_type: 'image/png', data: '' })],
    ['non-string data', image({ type: 'base64', media_type: 'image/png', data: 42 })],
    ['a null element', null],
    ['a missing source', { type: 'image' }],
    ['a url source', image({ type: 'url', media_type: 'image/png', data: 'AAAA' })],
    ['an unsupported media type', image({ type: 'base64', media_type: 'image/bmp', data: 'AAAA' })],
  ])('rejects %s', (_label, block) => {
    expect(isImageBlock(block)).toBe(false);
  });
});
