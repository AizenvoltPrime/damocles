import { describe, expect, it } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { makeFakeHost, makeMultiViewHost } from './panel-manager-harness';
import { postToSenders, recordSender } from '../send-senders';

const returned = (correlationId?: string): ExtensionToWebviewMessage => ({ type: 'promptReturned', content: [{ type: 'text', text: 'hi' }], reason: 'promptRejected', ...(correlationId !== undefined ? { correlationId } : {}) });

function shared() {
  const panel = makeMultiViewHost();
  const posted: Array<[string, ExtensionToWebviewMessage]> = [];
  const post = (message: ExtensionToWebviewMessage): void => postToSenders(panel, message, (host, routed, except) => {
    const to = host === panel ? 'every view' : ['view-1', 'view-2'].find((key) => panel.viewHost!(key) === host) ?? 'another host';
    posted.push([except === undefined ? to : `${to} but ${except.join(', ')}`, routed]);
  });
  return { panel, posted, post };
}

describe('what core gives back from a send', () => {
  it('returns a refused send to the view that sent it alone, the other views only dropping its echo, and everything else to every view', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-2', 'corr-1');
    post({ type: 'processing', isProcessing: false });
    post(returned('corr-1'));
    expect(posted).toEqual([
      ['every view', { type: 'processing', isProcessing: false }],
      ['view-2', returned('corr-1')],
      ['every view but view-2', { type: 'promptReturned', content: [], reason: 'promptRejected', correlationId: 'corr-1' }],
    ]);
  });

  it('puts a send stopped before pi took it back in the composer of the view that sent it alone, the other views only dropping its echo', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-1', 'corr-1');
    post({ type: 'interruptRecovery', correlationId: 'corr-1', promptContent: 'look', contentBlocks: [{ type: 'text', text: 'look' }] });
    expect(posted).toEqual([
      ['view-1', { type: 'interruptRecovery', correlationId: 'corr-1', promptContent: 'look', contentBlocks: [{ type: 'text', text: 'look' }] }],
      ['every view but view-1', { type: 'interruptRecovery', correlationId: 'corr-1', promptContent: '' }],
    ]);
    // a stop of a send no view is recorded for (a local panel's, or one core wrote) goes to every view as it is
    post({ type: 'interruptRecovery', correlationId: 'corr-core', promptContent: 'plan' });
    expect(posted.at(-1)).toEqual(['every view', { type: 'interruptRecovery', correlationId: 'corr-core', promptContent: 'plan' }]);
  });

  it('puts a queued message back in the composer of the view that queued it, and takes its chip from the other views', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-1', 'q-1');
    post({ type: 'queueCancelled', messageId: 'q-1', returnToInput: true });
    expect(posted).toEqual([
      ['view-1', { type: 'queueCancelled', messageId: 'q-1', returnToInput: true }],
      ['every view but view-1', { type: 'queueCancelled', messageId: 'q-1' }],
    ]);
  });

  it('gives a refused queued batch and the settings it opens to the views that queued it', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-2', 'q-2');
    post({ type: 'queueCancelled', messageId: 'q-2' });
    post(returned());
    post({ type: 'openSettingsPanel', section: 'accounts', account: 'anthropic' } as ExtensionToWebviewMessage);
    expect(posted.map(([to, message]) => [to, message.type])).toEqual([['every view', 'queueCancelled'], ['view-2', 'promptReturned'], ['view-2', 'openSettingsPanel']]);
  });

  it('forgets a send once it committed, and a local panel with one view gets every message itself', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-2', 'corr-2');
    post({ type: 'userMessageIdAssigned', sdkMessageId: 'u1', correlationId: 'corr-2' });
    post(returned('corr-2'));
    expect(posted.map(([to]) => to)).toEqual(['every view', 'every view']);
    const local = makeFakeHost();
    const delivered: unknown[] = [];
    recordSender(local, undefined, 'corr-3');
    postToSenders(local, returned('corr-3'), (host, message) => delivered.push([host === local, message.type]));
    expect(delivered).toEqual([[true, 'promptReturned']]);
  });

  it('returns each message of a refused send that combined queued messages to the composer of the view that queued it', async () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-1', 'q-a1');
    recordSender(panel, 'view-2', 'q-b');
    recordSender(panel, 'view-1', 'q-a2');
    for (const id of ['q-a1', 'q-b', 'q-a2']) post({ type: 'queueCancelled', messageId: id, sentAs: 'corr-batch' });
    // the send is refused a few ticks later, after core's awaits
    await new Promise((resolve) => setImmediate(resolve));
    const text = (value: string) => [{ type: 'text' as const, text: value }];
    post({
      type: 'promptReturned',
      content: text('from a\n\nfrom b\n\nagain a'),
      reason: 'modelSignInRequired',
      correlationId: 'corr-batch',
      parts: [{ messageId: 'q-a1', content: text('from a') }, { messageId: 'q-b', content: text('from b') }, { messageId: 'q-a2', content: text('again a') }],
    });
    post({ type: 'openSettingsPanel', section: 'accounts' } as ExtensionToWebviewMessage);
    const returnedTo = posted.filter(([, message]) => message.type !== 'queueCancelled');
    expect(returnedTo).toEqual([
      ['view-1', { type: 'promptReturned', content: text('from a\n\nagain a'), reason: 'modelSignInRequired', correlationId: 'corr-batch' }],
      ['view-2', { type: 'promptReturned', content: text('from b'), reason: 'modelSignInRequired', correlationId: 'corr-batch' }],
      // the other views only drop the send's echo
      ['every view but view-1, view-2', { type: 'promptReturned', content: [], reason: 'modelSignInRequired', correlationId: 'corr-batch' }],
      ['view-1', { type: 'openSettingsPanel', section: 'accounts' }],
      ['view-2', { type: 'openSettingsPanel', section: 'accounts' }],
    ]);
  });

  it('returns each message of a stopped send that combined queued messages to the view that queued it', () => {
    const { panel, posted, post } = shared();
    recordSender(panel, 'view-2', 'q-b');
    post({ type: 'queueCancelled', messageId: 'q-b', sentAs: 'corr-batch' });
    post({ type: 'interruptRecovery', correlationId: 'corr-batch', promptContent: 'from b', parts: [{ messageId: 'q-b', content: [{ type: 'text', text: 'from b' }] }] });
    expect(posted.slice(1)).toEqual([
      ['view-2', { type: 'interruptRecovery', correlationId: 'corr-batch', promptContent: 'from b' }],
      ['every view but view-2', { type: 'interruptRecovery', correlationId: 'corr-batch', promptContent: '' }],
    ]);
  });

  it('keeps the senders of its 256 latest sends, so sends that are never named again do not pile up', () => {
    const { panel, posted, post } = shared();
    for (let i = 0; i <= 256; i++) recordSender(panel, 'view-2', `corr-${i}`);
    post(returned('corr-0'));
    post(returned('corr-1'));
    expect(posted.map(([to]) => to)).toEqual(['every view', 'view-2', 'every view but view-2']);
  });
});
