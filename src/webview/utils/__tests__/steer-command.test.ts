import { describe, it, expect } from 'vitest';
import type { ImageBlock, UserContentBlock } from '@shared/types/content';
import { parseSteerCommand } from '../steer-command';

const img = (data: string): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const text = (t: string): UserContentBlock => ({ type: 'text', text: t });

describe('parseSteerCommand', () => {
  it('parses a plain string steer', () => {
    expect(parseSteerCommand('/steer abc123 look at the parser')).toEqual({
      kind: 'steer',
      agentId: 'abc123',
      message: 'look at the parser',
      images: [],
    });
  });

  it('keeps a multi-line message', () => {
    expect(parseSteerCommand('/steer abc line one\nline two')).toMatchObject({ kind: 'steer', message: 'line one\nline two' });
  });

  it('carries pasted images with the text', () => {
    expect(parseSteerCommand([img('A'), img('B'), text('/steer abc look at this')])).toEqual({
      kind: 'steer',
      agentId: 'abc',
      message: 'look at this',
      images: [img('A'), img('B')],
    });
  });

  it('accepts an image-only steer', () => {
    expect(parseSteerCommand([img('A'), text('/steer abc')])).toEqual({ kind: 'steer', agentId: 'abc', message: '', images: [img('A')] });
  });

  it('rejects an attached browser element', () => {
    expect(parseSteerCommand([text('<element-context>...</element-context>'), img('S'), text('/steer abc msg')])).toEqual({ kind: 'elements' });
  });

  it('gives usage with no agent id', () => {
    expect(parseSteerCommand('/steer')).toEqual({ kind: 'usage' });
    expect(parseSteerCommand([img('A'), text('/steer')])).toEqual({ kind: 'usage' });
  });

  it('gives usage with neither text nor image', () => {
    expect(parseSteerCommand('/steer abc')).toEqual({ kind: 'usage' });
    expect(parseSteerCommand('/steer abc   ')).toEqual({ kind: 'usage' });
  });

  it('is none when /steer is not the typed text', () => {
    expect(parseSteerCommand('hello')).toEqual({ kind: 'none' });
    expect(parseSteerCommand('/steering wheel')).toEqual({ kind: 'none' });
    expect(parseSteerCommand([text('/steer abc msg'), img('A')])).toEqual({ kind: 'none' });
    expect(parseSteerCommand([img('A')])).toEqual({ kind: 'none' });
  });
});
