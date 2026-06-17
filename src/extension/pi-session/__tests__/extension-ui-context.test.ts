import { describe, it, expect } from 'vitest';
import { WebviewExtensionUIContext } from '../extension-ui-context';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;

function lastRequest(out: ExtensionToWebviewMessage[]): UiRequest {
  const req = [...out].reverse().find((m): m is UiRequest => m.type === 'extensionUiRequest');
  if (!req) throw new Error('no extensionUiRequest emitted');
  return req;
}

describe('WebviewExtensionUIContext (US-026)', () => {
  it('select posts an extensionUiRequest and resolves from a webview response', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.select('Pick one', ['a', 'b']);
    const req = lastRequest(out);
    expect(req).toMatchObject({ kind: 'select', title: 'Pick one', options: ['a', 'b'] });
    ui.resolve(req.requestId, 'b');
    expect(await promise).toBe('b');
  });

  it('confirm maps the boolean response', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.confirm('Sure?', 'really?');
    ui.resolve(lastRequest(out).requestId, true);
    expect(await promise).toBe(true);
  });

  it('input returns undefined when the webview reports cancellation (null)', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.input('Name?', 'type here');
    ui.resolve(lastRequest(out).requestId, null);
    expect(await promise).toBeUndefined();
  });

  it('cancelAll settles every pending dialog as cancelled', async () => {
    const ui = new WebviewExtensionUIContext(() => {}, () => 'SID');
    const a = ui.input('A?');
    const b = ui.select('B?', ['x']);
    ui.cancelAll();
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
  });

  it('notify maps to a webview notification', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    ui.notify('hello', 'warning');
    expect(out[0]).toEqual({ type: 'notification', message: 'hello', notificationType: 'warning' });
  });
});
