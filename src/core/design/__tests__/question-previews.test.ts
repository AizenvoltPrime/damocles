import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { DESIGN_RENDER_CLIENT_ABSENT } from '../../../shared/design-render';
import { LocalizedError } from '../../../shared/localized-text';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { createDesignHandlers } from '../../chat-panel/message-router/handlers/design-handlers';
import type { HandlerContext, HandlerDependencies } from '../../chat-panel/message-router/types';
import { askedQuestions, designPreviewPathOf, DesignPreviewImages } from '../question-previews';

vi.mock('../../logger', () => ({ log: vi.fn() }));

const DESIGN = 'contacts-1a2b3c4d';
// a PNG signature and IHDR of 1950 × 1371
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x07, 0x9e, 0, 0, 0x05, 0x5b]);
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function designFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'question-previews-'));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, 'variants', 'a'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'design.md'), '---\napp: Vue\nviewports:\n  primary: 1280\n  checked: [base]\n  journey: []\n---\n');
  fs.writeFileSync(path.join(folder, 'variants', 'a', 'S1.html'), '<html data-ds-screen="S1"><title>A</title></html>');
  return folder;
}

function render(): DesignPreviewHost & { captures: unknown[][] } {
  const captures: unknown[][] = [];
  return {
    captures,
    open: async () => true,
    changed: () => undefined,
    probe: () => Promise.reject(new Error('unused')),
    journey: () => Promise.reject(new Error('unused')),
    replayJourney: () => Promise.reject(new Error('unused')),
    capture: async (...args) => {
      captures.push(args);
      return { png: PNG, cssWidth: args[2], cssHeight: 900, contentHeight: 900, scale: 1.523 };
    },
  };
}

const QUESTIONS = [{ question: 'Layout?', header: 'Layout', multiSelect: false, options: [{ label: 'A', description: '', preview: { kind: 'design', path: 'variants/a/S1.html' } }, { label: 'B', description: '' }] }];
const BRANCH = [
  { type: 'message', message: { role: 'user', content: 'hi' } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Which?' }, { type: 'toolCall', id: 'q1', name: 'AskUserQuestion', arguments: { questions: QUESTIONS } }] } },
];

describe('design-kind question previews', () => {
  it('finds an option\'s design path in the call the branch holds, and nothing for any other option or call', () => {
    expect(designPreviewPathOf(askedQuestions(BRANCH, 'q1'), 0, 0)).toBe('variants/a/S1.html');
    expect(designPreviewPathOf(askedQuestions(BRANCH, 'q1'), 0, 1)).toBeUndefined();
    expect(designPreviewPathOf(askedQuestions(BRANCH, 'q1'), 3, 0)).toBeUndefined();
    expect(askedQuestions(BRANCH, 'q2')).toBeUndefined();
  });

  it('takes a path from the branch only under the question manager\'s rule, so a refused call names no file', () => {
    const named = (path: string) => [{ options: [{ label: 'A', preview: { kind: 'design', path } }] }];
    for (const path of ['design.md', 'manifest.json', 'index.html', '../other/screens/S1.html', 'screens/../index.html', 'screens\\S1.html']) {
      expect(designPreviewPathOf(named(path), 0, 0), path).toBeUndefined();
    }
    expect(designPreviewPathOf(named('screens/S1.html'), 0, 0)).toBe('screens/S1.html');
  });

  it('captures at the primary width once per content hash, and again after the design changed', async () => {
    const folder = designFolder();
    const host = render();
    const images = new DesignPreviewImages();
    const signal = new AbortController().signal;
    const first = await images.image(host, DESIGN, folder, 'variants/a/S1.html', signal);
    expect(first).toEqual({ mimeType: 'image/png', data: Buffer.from(PNG).toString('base64'), width: 1950, height: 1371 });
    await images.image(host, DESIGN, folder, 'variants/a/S1.html', signal);
    expect(host.captures).toEqual([[DESIGN, 'variants/a/S1.html', 1280, null, 2, signal]]);
    fs.appendFileSync(path.join(folder, 'variants', 'a', 'S1.html'), '\n');
    await images.image(host, DESIGN, folder, 'variants/a/S1.html', signal);
    expect(host.captures).toHaveLength(2);
  });

  it('names the refusal while no client renders designs, and a file that is not a screen', async () => {
    const folder = designFolder();
    const absent: DesignPreviewHost = { ...render(), capture: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)) };
    const images = new DesignPreviewImages();
    await expect(images.image(absent, DESIGN, folder, 'variants/a/S1.html', new AbortController().signal)).rejects.toThrow(LocalizedError);
    await expect(images.image(render(), DESIGN, folder, 'variants/b/S1.html', new AbortController().signal)).rejects.toThrow(/is not a screen of this design/);
  });
});

describe('requestDesignPreviewImage', () => {
  function setup(questionPreviewImage: (...args: unknown[]) => Promise<unknown>) {
    const posted: ExtensionToWebviewMessage[] = [];
    const handlers = createDesignHandlers({ platform: {}, postMessage: (_to: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
    const ctx = { reply: {}, panelId: 'p1', session: { design: { questionPreviewImage } }, permissionHandler: { openQuestions: (id: string) => (id === 'q1' ? QUESTIONS : undefined) } } as unknown as HandlerContext;
    return { posted, request: (message: Record<string, unknown>) => handlers.requestDesignPreviewImage!({ type: 'requestDesignPreviewImage', ...message } as never, ctx) };
  }

  it('answers the asking view with the image, passing the open question\'s options', async () => {
    const image = { mimeType: 'image/png', data: 'AQID', width: 10, height: 10 };
    const asked = vi.fn(async () => image);
    const { posted, request } = setup(asked);
    await request({ requestId: 'r1', toolUseId: 'q1', questionIndex: 0, optionIndex: 0 });
    expect(asked).toHaveBeenCalledWith('q1', 0, 0, QUESTIONS);
    expect(posted).toEqual([{ type: 'designPreviewImage', requestId: 'r1', image }]);
  });

  it('answers an error as LocalizedText, and drops a request with no usable id', async () => {
    const { posted, request } = setup(async () => {
      throw new LocalizedError({ message: 'No Damocles app is attached to render this design.' });
    });
    await request({ requestId: 'r1', toolUseId: 'q1', questionIndex: 0, optionIndex: 0 });
    await request({ requestId: 'r2', toolUseId: 'q1', questionIndex: -1, optionIndex: 0 });
    await request({ requestId: 42, toolUseId: 'q1', questionIndex: 0, optionIndex: 0 });
    expect(posted).toEqual([
      { type: 'designPreviewImage', requestId: 'r1', error: { message: 'No Damocles app is attached to render this design.' } },
      { type: 'designPreviewImage', requestId: 'r2', error: { message: 'This option has no design preview.' } },
    ]);
  });
});
