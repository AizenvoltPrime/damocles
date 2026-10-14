import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock('electron', () => ({
  WebContentsView: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
  dialog: { showMessageBox: (...args: unknown[]) => H.showMessageBox(...args) },
}));

import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { createMessageAsker, type MessageOverlay, type MessageQuestion } from '../message-dialog';
import { parseMessageRequest } from '../overlay';

// The editor's save prompt: Save and Don't Save only; Escape, the scrim or the box's close cancel.
const SAVE_PROMPT: MessageQuestion = {
  severity: 'warning',
  message: 'Do you want to save the changes you made to a.ts?',
  detail: "Your changes will be lost if you don't save them.",
  actions: ['Save', "Don't Save"],
  defaultAction: 0,
};

beforeEach(() => {
  H.showMessageBox.mockReset();
});

function asker(overlay: MessageOverlay | undefined, closing = () => false) {
  return createMessageAsker({ overlay: () => overlay, window: () => undefined, focused: () => undefined, closing, log: () => undefined });
}

describe('a question while a quit closes the window', () => {
  it('answers Cancel without the OS box once the window that was asking closed, so the request asking it settles', async () => {
    let closing = false;
    let fail!: (err: Error) => void;
    const ask = asker({ request: () => new Promise<OverlayAnswer>((_resolve, reject) => (fail = reject)) }, () => closing);
    const asked = ask(SAVE_PROMPT);
    closing = true;
    fail(new Error('The overlay closed'));
    await expect(asked).resolves.toBeUndefined();
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('answers Cancel at once for a question asked after the window closed', async () => {
    await expect(asker(undefined, () => true)(SAVE_PROMPT)).resolves.toBeUndefined();
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('still asks with the OS box when the overlay fails outside a quit', async () => {
    H.showMessageBox.mockResolvedValue({ response: 0 });
    await expect(asker({ request: () => Promise.reject(new Error('crashed')) })(SAVE_PROMPT)).resolves.toBe(0);
    expect(H.showMessageBox).toHaveBeenCalledOnce();
  });
});

describe('a question without a Cancel button', () => {
  it('reaches the overlay with no cancel label, and its Escape (null) cancels', async () => {
    const requests: OverlayRequest[] = [];
    const answers: OverlayAnswer[] = [{ kind: 'message', action: null }, { kind: 'message', action: 1 }];
    const ask = asker({ request: async (request) => { requests.push(request); return answers.shift()!; } });
    await expect(ask(SAVE_PROMPT)).resolves.toBeUndefined();
    await expect(ask(SAVE_PROMPT)).resolves.toBe(1);
    expect(requests[0]).toEqual({ kind: 'message', ...SAVE_PROMPT });
    expect(requests[0]).not.toHaveProperty('cancelLabel');
  });

  it('shows only Save and Don\'t Save in the OS box, whose Escape returns the cancel id past them', async () => {
    H.showMessageBox.mockResolvedValue({ response: 2 });
    await expect(asker(undefined)(SAVE_PROMPT)).resolves.toBeUndefined();
    expect(H.showMessageBox.mock.calls[0]![0]).toMatchObject({ buttons: ['Save', "Don't Save"], cancelId: 2, defaultId: 0 });
    H.showMessageBox.mockResolvedValue({ response: 1 });
    await expect(asker(undefined)(SAVE_PROMPT)).resolves.toBe(1);
  });

  it('needs a focused action when it has no Cancel, and keeps bounding a Cancel label that is there', () => {
    const { defaultAction: _focus, ...unfocused } = SAVE_PROMPT;
    expect(parseMessageRequest({ kind: 'message', ...unfocused })).toBeUndefined();
    expect(parseMessageRequest({ kind: 'message', ...SAVE_PROMPT, cancelLabel: '' })).toBeUndefined();
    expect(parseMessageRequest({ kind: 'message', ...SAVE_PROMPT, cancelLabel: 'Cancel' })).toMatchObject({ cancelLabel: 'Cancel' });
  });
});

describe('a question with a preview', () => {
  const PASTE: MessageQuestion = { severity: 'warning', message: 'Paste 2 lines?', preview: ['echo 1', 'echo 2'], actions: ['Paste'], cancelLabel: 'Cancel' };

  it('reaches the overlay with its preview lines', async () => {
    const requests: OverlayRequest[] = [];
    await asker({ request: async (request) => { requests.push(request); return { kind: 'message', action: 0 }; } })(PASTE);
    expect(requests[0]).toEqual({ kind: 'message', ...PASTE });
  });

  it('shows the preview under the detail in the OS box', async () => {
    H.showMessageBox.mockResolvedValue({ response: 1 });
    await expect(asker(undefined)({ ...PASTE, detail: 'Preview:' })).resolves.toBeUndefined();
    expect(H.showMessageBox.mock.calls[0]![0]).toMatchObject({ detail: 'Preview:\necho 1\necho 2', buttons: ['Paste', 'Cancel'] });
  });
});

describe('a withdrawn question', () => {
  const HOST_KEY: MessageQuestion = { severity: 'danger', message: 'Are you sure you want to continue connecting?', actions: ['Yes'], cancelLabel: 'No' };

  it('passes its signal to the overlay and answers Cancel once withdrawn, whatever the overlay answers later', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let answer!: (value: OverlayAnswer) => void;
    const ask = asker({ request: (_request, _focus, _shown, _browse, signal) => { signals.push(signal); return new Promise((resolve) => (answer = resolve)); } });
    const withdrawn = new AbortController();
    const asked = ask(HOST_KEY, withdrawn.signal);
    withdrawn.abort();
    answer({ kind: 'message', action: 0 });
    await expect(asked).resolves.toBeUndefined();
    expect(signals).toEqual([withdrawn.signal]);
  });

  it('asks nothing when already withdrawn', async () => {
    const request = vi.fn();
    const gone = new AbortController();
    gone.abort();
    await expect(asker({ request })(HOST_KEY, gone.signal)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('logs that the OS message box cannot be withdrawn, and ignores its answer', async () => {
    const lines: string[] = [];
    let respond!: (value: { response: number }) => void;
    H.showMessageBox.mockReturnValue(new Promise((resolve) => (respond = resolve)));
    const ask = createMessageAsker({ overlay: () => undefined, window: () => undefined, focused: () => undefined, closing: () => false, log: (line) => lines.push(line) });
    const withdrawn = new AbortController();
    const asked = ask(HOST_KEY, withdrawn.signal);
    await vi.waitFor(() => expect(H.showMessageBox).toHaveBeenCalledOnce());
    withdrawn.abort();
    respond({ response: 0 });
    await expect(asked).resolves.toBeUndefined();
    expect(lines).toContain('[dialog] a withdrawn question shows in the OS message box, which cannot be closed; its answer is ignored');
  });
});
