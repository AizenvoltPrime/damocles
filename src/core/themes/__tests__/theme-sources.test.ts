import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeAssetSource, themeImagePrompt } from '../../../shared/themes/asset-source';
import { MAX_MOVING_BYTES as MAX_WALLPAPER_BYTES } from '../../../shared/themes/wallpapers';
import { RedirectRefusedError, safeFetch } from '../../pi-session/web-access/safe-fetch';
import { attachmentSource, checkDeclaredType, fetchUrlSource, readFileSource, SourceRefusedError, themeSourceRefusal } from '../sources';
import { checkWallpaper } from '../assets';
import { jpeg, png, webpLossy } from '../../../shared/themes/testing/image-fixtures';
import { mp4, webm } from './video-fixtures';

vi.mock('../../pi-session/web-access/safe-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../pi-session/web-access/safe-fetch')>()), safeFetch: vi.fn() }));

// ThemeSet's image sources (docs/tools.md "Theme tools"): one source per call, refused when web search or image generation
// cannot serve it, its bytes bounded before they are read whole and checked against the type the source declares.

const fetched = vi.mocked(safeFetch);
const refusal = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof SourceRefusedError) return err.message;
    throw err;
  }
  throw new Error('not refused');
};

describe('themeAssetSource', () => {
  it('reads exactly one source of its shape', () => {
    expect(themeAssetSource({})).toBeUndefined();
    expect(themeAssetSource({ asset: { name: 'a', from: { file: 'a.png' } } })).toEqual({ kind: 'file', file: 'a.png' });
    expect(themeAssetSource({ asset: { name: 'a', from: { url: 'https://a.example/a.png' } } })).toEqual({ kind: 'url', url: 'https://a.example/a.png' });
    expect(themeAssetSource({ asset: { name: 'a', from: { generate: { prompt: 'dunes', aspect: '21:9' } } } })).toEqual({ kind: 'generate', prompt: 'dunes', aspect: '21:9' });
    expect(themeAssetSource({ asset: { name: 'a', from: { attachment: 2 } } })).toEqual({ kind: 'attachment', index: 2 });
    expect(themeAssetSource({ asset: { name: 'a', from: { pixels: [] } } })).toEqual({ kind: 'pixels', pixels: [] });
  });

  it('refuses two sources, none, an empty value, an unknown aspect or field', () => {
    for (const from of [{ file: 'a.png', url: 'https://a.example/a.png' }, {}, { file: '' }, { url: 3 }, { generate: { prompt: ' ' } }, { generate: { prompt: 'x', seed: 1 } }, { attachment: '1' }, { disk: 'a' }, 'a.png']) {
      expect(themeAssetSource({ asset: { name: 'a', from } }), JSON.stringify(from)).toHaveProperty('refused');
    }
    expect(themeAssetSource({ asset: { name: 'a', from: { generate: { prompt: 'x', aspect: '5:4' } } } })).toEqual({ refused: expect.stringContaining('aspect is one of 16:9') });
  });

  it('sends the aspect inside the prompt the card shows', () => {
    expect(themeImagePrompt({ prompt: 'dunes' })).toBe('dunes');
    expect(themeImagePrompt({ prompt: 'dunes', aspect: '9:16' })).toBe('dunes\n\nAspect ratio 9:16 (width:height).');
  });
});

describe('themeSourceRefusal', () => {
  it('refuses a URL while web search is off and a generation while image generation cannot run, naming why', () => {
    const url = { kind: 'url', url: 'https://a.example/a.png' } as const;
    const generate = { kind: 'generate', prompt: 'dunes' } as const;
    expect(themeSourceRefusal(url, { webSearch: false, imageGeneration: 'on' })).toContain('only while Web search is on');
    expect(themeSourceRefusal(url, { webSearch: true, imageGeneration: 'off' })).toBeUndefined();
    expect(themeSourceRefusal(generate, { webSearch: true, imageGeneration: 'off' })).toContain('Image generation is off');
    expect(themeSourceRefusal(generate, { webSearch: true, imageGeneration: 'noModel' })).toContain('no model');
    expect(themeSourceRefusal(generate, { webSearch: true, imageGeneration: 'noOpenRouterKey' })).toContain('OpenRouter key');
    expect(themeSourceRefusal(generate, { webSearch: false, imageGeneration: 'on' })).toBeUndefined();
    expect(themeSourceRefusal({ kind: 'file', file: 'a.png' }, { webSearch: false, imageGeneration: 'off' })).toBeUndefined();
    expect(themeSourceRefusal({ kind: 'attachment', index: 1 }, { webSearch: false, imageGeneration: 'off' })).toBeUndefined();
  });
});

describe('checkDeclaredType', () => {
  it('accepts bytes of the declared image type, and leaves a type that names no image to the bytes', () => {
    expect(() => checkDeclaredType(png(1, 1), 'image/png', 'x')).not.toThrow();
    expect(() => checkDeclaredType(jpeg(1, 1), 'image/jpg', 'x')).not.toThrow();
    expect(() => checkDeclaredType(jpeg(1, 1), 'IMAGE/JPEG; charset=binary', 'x')).not.toThrow();
    expect(() => checkDeclaredType(png(1, 1), 'application/octet-stream', 'x')).not.toThrow();
    expect(() => checkDeclaredType(png(1, 1), undefined, 'x')).not.toThrow();
  });

  it('refuses bytes another type than declared, or no image at all', async () => {
    expect(await refusal(() => checkDeclaredType(png(1, 1), 'image/jpeg', 'beach'))).toBe('beach is declared as image/jpeg but holds image/png, so it was not used.');
    expect(await refusal(() => checkDeclaredType(new Uint8Array([1, 2, 3]), 'image/webp', 'beach'))).toContain('holds no image Damocles reads');
  });

  it('checks a declared video type against the container its bytes start like', async () => {
    expect(() => checkDeclaredType(mp4(), 'video/mp4', 'x')).not.toThrow();
    expect(() => checkDeclaredType(webm(), 'video/webm; codecs=vp9', 'x')).not.toThrow();
    expect(() => checkDeclaredType(png(2, 2, { animated: true }), 'image/apng', 'x')).not.toThrow();
    expect(await refusal(() => checkDeclaredType(webm(), 'video/mp4', 'clip'))).toBe('clip is declared as video/mp4 but holds video/webm, so it was not used.');
    expect(await refusal(() => checkDeclaredType(png(1, 1), 'video/webm', 'clip'))).toBe('clip is declared as video/webm but holds image/png, so it was not used.');
  });
});

describe('readFileSource', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-source-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reads a path relative to the chat folder, as Read resolves it', async () => {
    fs.mkdirSync(path.join(cwd, 'img'));
    fs.writeFileSync(path.join(cwd, 'img', 'beach.png'), png(2, 2));
    const read = await readFileSource('img/beach.png', cwd);
    expect(Buffer.from(read.bytes).equals(Buffer.from(png(2, 2)))).toBe(true);
    expect(read.name).toBe(path.join(cwd, 'img', 'beach.png'));
  });

  it('refuses a folder, a missing file and one past the wallpaper cap, before reading it whole', async () => {
    fs.mkdirSync(path.join(cwd, 'folder.png'));
    expect(await refusal(() => readFileSource('folder.png', cwd))).toContain('is not a regular file');
    expect(await refusal(() => readFileSource('missing.png', cwd))).toContain('does not exist');
    const big = path.join(cwd, 'big.png');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, MAX_WALLPAPER_BYTES + 1);
    expect(await refusal(() => readFileSource(big, cwd))).toContain('is larger than 40 MiB');
  });
});

describe('fetchUrlSource', () => {
  afterEach(() => {
    fetched.mockReset();
  });

  it('fetches https only, refuses every redirect, and returns the body with its declared type', async () => {
    fetched.mockResolvedValue(new Response(Buffer.from(png(1, 1)), { status: 200, headers: { 'content-type': 'image/png' } }));
    const got = await fetchUrlSource('https://images.example/walls/beach.png?w=1', new AbortController().signal);
    expect(got).toMatchObject({ declared: 'image/png' });
    expect(Buffer.from(got.bytes).equals(Buffer.from(png(1, 1)))).toBe(true);
    const options = fetched.mock.calls[0]![2]!;
    expect(options.httpsOnly).toBe(true);
    expect(options.redirectRefused?.('https://images.example/other.png')).toBe(true);
  });

  it('names a redirect target for a call of its own, and refuses http, a failed status and a body past the cap', async () => {
    fetched.mockRejectedValueOnce(new RedirectRefusedError('https://images.example/a.png', 'https://cdn.example/a.png', 302));
    expect(await refusal(() => fetchUrlSource('https://images.example/a.png', new AbortController().signal))).toContain('redirects to https://cdn.example/a.png. ThemeSet follows no redirect');
    expect(await refusal(() => fetchUrlSource('http://images.example/a.png', new AbortController().signal))).toContain('not an https URL');
    expect(fetched).toHaveBeenCalledTimes(1);
    fetched.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    expect(await refusal(() => fetchUrlSource('https://images.example/a.png', new AbortController().signal))).toBe('https://images.example/a.png answered HTTP 404.');
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ > MAX_WALLPAPER_BYTES / chunk.length) controller.close();
        else controller.enqueue(chunk);
      },
    });
    fetched.mockResolvedValueOnce(new Response(body, { status: 200 }));
    expect(await refusal(() => fetchUrlSource('https://images.example/huge.png', new AbortController().signal))).toContain('is larger than 40 MB');
  });
});

describe('attachmentSource', () => {
  const one = [{ data: Buffer.from(png(1, 1)).toString('base64'), mimeType: 'image/png' }];

  it('takes the n-th attached image, counting from 1, with its declared type', () => {
    expect(attachmentSource(one, 1)).toMatchObject({ declared: 'image/png' });
  });

  it('refuses an index outside the attached images, and one past the cap before decoding it', async () => {
    expect(await refusal(() => attachmentSource([], 1))).toBe('The user attached no image in this chat.');
    for (const index of [0, 2, 1.5, -1]) expect(await refusal(() => attachmentSource(one, index))).toContain(`attachment ${index} is not one of them`);
    const huge = [{ data: 'A'.repeat(Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4 + 4), mimeType: 'image/png' }];
    expect(await refusal(() => attachmentSource(huge, 1))).toContain('larger than 40 MB');
  });
});

describe('fetchUrlSource: what a URL is called and how long it may take', () => {
  const signal = (): AbortSignal => new AbortController().signal;
  // a body as undici gives one: it ends in an error when the request's signal aborts
  const bodyOf = (init: RequestInit | undefined, start: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        start(controller);
      },
    }), { status: 200, headers: { 'content-type': 'image/png' } });

  afterEach(() => {
    fetched.mockReset();
    vi.useRealTimers();
  });

  it.each([
    'https://images.example/render.php?id=3',
    'https://images.example/photo.jpg',
    'https://images.example/photo.jpg!large',
  ])('gives %s no file name, so its bytes and declared type alone say what it is', async (url) => {
    fetched.mockResolvedValueOnce(new Response(Buffer.from(webpLossy(320, 200)), { status: 200, headers: { 'content-type': 'image/webp' } }));
    const got = await fetchUrlSource(url, signal());
    expect(got).not.toHaveProperty('name');
    checkDeclaredType(got.bytes, got.declared, url);
    expect(checkWallpaper(got.bytes, (got as { name?: string }).name)).toMatchObject({ format: 'webp', width: 320, height: 200 });
  });

  it('takes a body that keeps moving for longer than the stall time', async () => {
    vi.useFakeTimers();
    fetched.mockImplementationOnce(async (_url, init) => bodyOf(init, (controller) => {
      let sent = 0;
      const timer = setInterval(() => {
        controller.enqueue(new Uint8Array(10));
        if (++sent === 6) {
          clearInterval(timer);
          controller.close();
        }
      }, 20_000);
    }));
    const pending = fetchUrlSource('https://images.example/slow.png', signal());
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await pending).bytes).toHaveLength(60);
  });

  it('stops a body that sends nothing for 30 seconds, and says so', async () => {
    vi.useFakeTimers();
    fetched.mockImplementationOnce(async (_url, init) => bodyOf(init, (controller) => controller.enqueue(new Uint8Array(10))));
    const pending = refusal(() => fetchUrlSource('https://images.example/stuck.png', signal()));
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('https://images.example/stuck.png sent nothing for 30 seconds, so the download stopped.');
  });

  it('stops a body that drips past the whole download\'s 10 minutes, and says so', async () => {
    vi.useFakeTimers();
    fetched.mockImplementationOnce(async (_url, init) => bodyOf(init, (controller) => {
      const timer = setInterval(() => controller.enqueue(new Uint8Array(1)), 20_000);
      init?.signal?.addEventListener('abort', () => clearInterval(timer));
    }));
    const pending = refusal(() => fetchUrlSource('https://images.example/drip.png', signal()));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await pending).toBe('The download of https://images.example/drip.png took longer than 10 minutes, so it stopped.');
  });

  it('refuses a fetch that fails for any other reason, with the reason, and never throws another error', async () => {
    fetched.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND images.example') }));
    expect(await refusal(() => fetchUrlSource('https://images.example/a.png', signal()))).toBe('https://images.example/a.png could not be fetched: fetch failed (getaddrinfo ENOTFOUND images.example).');
    fetched.mockImplementationOnce(async (_url, init) => bodyOf(init, (controller) => controller.error(new Error('socket hang up'))));
    expect(await refusal(() => fetchUrlSource('https://images.example/a.png', signal()))).toBe('https://images.example/a.png could not be fetched: socket hang up.');
  });

  it('leaves the turn\'s own abort as it is', async () => {
    const turn = new AbortController();
    fetched.mockImplementationOnce(async (_url, init) => bodyOf(init, () => undefined));
    const pending = fetchUrlSource('https://images.example/a.png', AbortSignal.any([turn.signal]));
    const failed = pending.then(() => undefined, (err: unknown) => err);
    turn.abort(new Error('the turn ended'));
    expect(await failed).not.toBeInstanceOf(SourceRefusedError);
  });
});
