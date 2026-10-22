import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyInlineImage, inlineImageMediaType, sniffImageMediaType } from '../inline-image';
import { isAttachableImageMimeType, isBinaryMimeType, isDirectoryResource, isTextMimeType } from '../mcp-resource-mime';
import { MAX_IMAGE_BASE64_LENGTH } from '../types/content';
import { base64Of as b64, IMAGE_BYTES } from './image-bytes';

const PI_MIME = path.resolve(__dirname, '../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/mime.js');

describe('sniffImageMediaType', () => {
  it('agrees with pi 1.4.0 detectSupportedImageMimeType on every fixture, except BMP, which no provider takes inline', async () => {
    const pi = (await import(pathToFileURL(PI_MIME).href)) as { detectSupportedImageMimeType: (buffer: Uint8Array) => string | null };
    for (const [name, bytes] of Object.entries(IMAGE_BYTES)) {
      const theirs = pi.detectSupportedImageMimeType(Buffer.from(bytes));
      expect(sniffImageMediaType(bytes), name).toBe(theirs === 'image/bmp' ? null : theirs);
    }
    expect(pi.detectSupportedImageMimeType(Buffer.from(IMAGE_BYTES.bmp))).toBe('image/bmp');
  });
});

describe('classifyInlineImage', () => {
  it('takes the media type from the bytes, not the label', () => {
    expect(classifyInlineImage(b64(IMAGE_BYTES.jpeg), 'image/png')).toEqual({ ok: true, mediaType: 'image/jpeg', data: b64(IMAGE_BYTES.jpeg) });
    expect(classifyInlineImage(b64(IMAGE_BYTES.png), undefined)).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(classifyInlineImage(b64(IMAGE_BYTES.gif), 'image/gif; charset=binary')).toMatchObject({ ok: true, mediaType: 'image/gif' });
    expect(classifyInlineImage(b64(IMAGE_BYTES.webp), 'IMAGE/WEBP')).toMatchObject({ ok: true, mediaType: 'image/webp' });
  });

  it('reads image/jpg as image/jpeg, as pi does', () => {
    expect(inlineImageMediaType('image/jpg')).toBe('image/jpeg');
    expect(classifyInlineImage(b64(IMAGE_BYTES.jpeg), 'image/jpg')).toMatchObject({ ok: true, mediaType: 'image/jpeg' });
  });

  it('refuses a label naming a type providers do not take, svg and tiff included', () => {
    expect(classifyInlineImage(b64(IMAGE_BYTES.svg), 'image/svg+xml')).toEqual({ ok: false, reason: 'unsupportedType' });
    expect(classifyInlineImage(b64(IMAGE_BYTES.tiff), 'image/tiff')).toEqual({ ok: false, reason: 'unsupportedType' });
    expect(classifyInlineImage(b64(IMAGE_BYTES.png), 'application/octet-stream')).toEqual({ ok: false, reason: 'unsupportedType' });
  });

  it('refuses bytes that are not a PNG, JPEG, GIF or WebP whatever the label says', () => {
    for (const bytes of [IMAGE_BYTES.tiff, IMAGE_BYTES.bmp, IMAGE_BYTES.svg, IMAGE_BYTES.apng, IMAGE_BYTES.jpegLs]) {
      expect(classifyInlineImage(b64(bytes), 'image/png')).toEqual({ ok: false, reason: 'unrecognized' });
    }
  });

  it('refuses data past MAX_IMAGE_BASE64_LENGTH and data that is not padded base64, without decoding it', () => {
    const png = b64(IMAGE_BYTES.png);
    const pngOfBytes = (length: number): string => {
      const bytes = new Uint8Array(length);
      bytes.set(IMAGE_BYTES.png);
      return b64(bytes);
    };
    expect(pngOfBytes((MAX_IMAGE_BASE64_LENGTH / 4) * 3)).toHaveLength(MAX_IMAGE_BASE64_LENGTH);
    expect(classifyInlineImage(pngOfBytes((MAX_IMAGE_BASE64_LENGTH / 4) * 3), 'image/png')).toMatchObject({ ok: true });
    expect(classifyInlineImage(pngOfBytes((MAX_IMAGE_BASE64_LENGTH / 4) * 3 + 1), 'image/png')).toEqual({ ok: false, reason: 'tooLarge' });
    for (const data of ['', 'not base64!', 'iVBORw0', `${png.slice(0, 8)}\n${png.slice(8, -1)}`, `-_${png.slice(2)}`]) {
      expect(classifyInlineImage(data, 'image/png'), JSON.stringify(data)).toEqual({ ok: false, reason: 'notBase64' });
    }
  });

  it('checks the base64 shape in linear time', () => {
    const started = performance.now();
    expect(classifyInlineImage(`${'A'.repeat(MAX_IMAGE_BASE64_LENGTH - 4)}AAA!`, 'image/png')).toEqual({ ok: false, reason: 'notBase64' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('MCP resource MIME types', () => {
  it('reads svg as text, and only png, jpeg (image/jpg too), gif and webp as images', () => {
    expect(isTextMimeType('image/svg+xml')).toBe(true);
    expect(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].every(isAttachableImageMimeType)).toBe(true);
    expect(['image/svg+xml', 'image/tiff', 'image/bmp', 'image/heic', undefined].some(isAttachableImageMimeType)).toBe(false);
  });

  it('calls only clearly binary families binary, leaving every other label to the read', () => {
    for (const type of ['application/octet-stream', 'application/pdf', 'application/zip', 'audio/mpeg', 'image/tiff', 'image/x-icon']) {
      expect(isBinaryMimeType(type), type).toBe(true);
    }
    for (const type of [
      'application/javascript', 'application/xml', 'application/sql', 'application/x-sh', 'application/toml', 'video/mp2t',
      'text/plain', 'application/json', 'image/svg+xml', 'image/png', 'image/jpg', 'inode/directory', undefined,
    ]) {
      expect(isBinaryMimeType(type), String(type)).toBe(false);
    }
  });

  it('lets an explicit MIME type decide a directory, and a URI ending in / only when there is none', () => {
    expect(isDirectoryResource('https://site/', 'text/html')).toBe(false);
    expect(isDirectoryResource('docs://folder/', undefined)).toBe(true);
    expect(isDirectoryResource('docs://folder', 'inode/directory; x=1')).toBe(true);
    expect(isDirectoryResource('docs://file', undefined)).toBe(false);
  });
});
