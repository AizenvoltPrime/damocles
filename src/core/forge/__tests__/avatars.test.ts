import { describe, expect, it, vi } from 'vitest';
import { avatarKey, fetchAvatar, sniffAvatar } from '../avatars';
import { createForgeHttp } from '../http';
import type { ForgeServer, ServerRecord } from '../types';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const record: ServerRecord = { id: 'github.com', kind: 'github', flavor: 'github.com', gitHosts: [], addedAt: 0 };
const GITHUB: ForgeServer = { record, id: 'github.com', kind: 'github', flavor: 'github.com', builtIn: true, webUrl: 'https://github.com', apiUrl: 'https://api.github.com', origins: new Set(['https://github.com', 'https://api.github.com']) };

describe('avatars', () => {
  it('passes PNG, JPEG, GIF and WebP by their bytes, and nothing else', () => {
    expect(sniffAvatar(PNG)).toBe('image/png');
    expect(sniffAvatar(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffAvatar(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffAvatar(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffAvatar(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeUndefined();
    expect(sniffAvatar(new TextEncoder().encode('<!doctype html><img src=x onerror=alert(1)>'))).toBeUndefined();
    expect(sniffAvatar(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(sniffAvatar(new Uint8Array(0))).toBeUndefined();
  });

  it('keys a picture by server and URL, opaquely', () => {
    expect(avatarKey('github.com', 'https://avatars.githubusercontent.com/u/1')).toMatch(/^[0-9a-f]{64}$/);
    expect(avatarKey('github.com', 'https://a/1')).not.toBe(avatarKey('ghe.example', 'https://a/1'));
  });

  it('sends the token only to the server\'s own origin, and fetches a third-party picture without it through the SSRF guard', async () => {
    const sent: { url: string; authorization: string | undefined }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, authorization: (init?.headers as Record<string, string>)['Authorization'] });
      return new Response(PNG, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const publicFetch = vi.fn((url: string, init: RequestInit) => fetch(url, init));
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch });
    const token = vi.fn(async () => 'gho_avatarToken');
    await expect(fetchAvatar(http, GITHUB, 'https://avatars.githubusercontent.com/u/1001?v=4', token, () => undefined)).resolves.toMatchObject({ mime: 'image/png' });
    await expect(fetchAvatar(http, GITHUB, 'https://github.com/avatars/astefanopoulos.png', token, () => undefined)).resolves.toMatchObject({ mime: 'image/png' });
    expect(sent).toEqual([
      { url: 'https://avatars.githubusercontent.com/u/1001?v=4', authorization: undefined },
      { url: 'https://github.com/avatars/astefanopoulos.png', authorization: 'Bearer gho_avatarToken' },
    ]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });

  it('shows no picture that is not an allowed image, and fetches no http URL', async () => {
    const fetch = vi.fn(async () => new Response('<svg/>', { status: 200 })) as unknown as typeof globalThis.fetch;
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch });
    await expect(fetchAvatar(http, GITHUB, 'https://avatars.example/x.svg', async () => 't', () => undefined)).resolves.toBeUndefined();
    await expect(fetchAvatar(http, GITHUB, 'http://avatars.example/x.png', async () => 't', () => undefined)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
