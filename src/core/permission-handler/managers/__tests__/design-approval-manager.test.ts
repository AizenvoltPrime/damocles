import { describe, expect, it } from 'vitest';
import { DesignApprovalManager, type DesignApprovalAsk } from '../design-approval-manager';
import { PermissionState } from '../../state';
import { PermissionHandler } from '../..';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';

const ASK: DesignApprovalAsk = {
  designId: 'contacts-abcd1234',
  summary: 'The contacts list.',
  previousVersion: 1,
  changes: [{ kind: 'screenChanged', screen: 'S1' }],
  warnings: [{ rule: 'a11y.label', severity: 'warning', screen: 'S1', element: 'button', message: 'No label.' }],
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }],
  screens: [{ id: 'S1', file: 'screens/S1-contacts.html' }],
  hasParent: true,
};

function setup(attached = true) {
  const state = new PermissionState();
  const posted: ExtensionToWebviewMessage[] = [];
  let changes = 0;
  state.onPendingChanged = () => changes++;
  const manager = new DesignApprovalManager(state, () => (attached ? (m) => posted.push(m) : null));
  return { state, posted, manager, changes: () => changes };
}

type Request = Extract<ExtensionToWebviewMessage, { type: 'requestDesignApproval' }>;
const request = (posted: ExtensionToWebviewMessage[]): Request => posted.find((m): m is Request => m.type === 'requestDesignApproval')!;
const closed = (posted: ExtensionToWebviewMessage[]) => posted.filter((m) => m.type === 'designApprovalClosed');

describe('DesignApprovalManager', () => {
  it('raises a designApproval prompt with the whole ask and the chat as its owner, and resolves with the answer', async () => {
    const { state, posted, manager } = setup();
    const answer = manager.requestDesignApproval(ASK, new AbortController().signal);
    const sent = request(posted);
    expect(sent).toEqual({ type: 'requestDesignApproval', promptId: sent.promptId, ...ASK, owner: { kind: 'main' } });
    expect(state.pendingPrompts()).toEqual([{ id: sent.promptId, kind: 'designApproval', request: sent }]);

    manager.resolveDesignApproval(sent.promptId, 'approve', undefined);
    expect(await answer).toEqual({ choice: 'approve' });
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'designApprovalClosed', promptId: sent.promptId });
  });

  it('keeps the prompt open for changes with a blank note, and passes a note on trimmed', async () => {
    const { state, posted, manager } = setup();
    const answer = manager.requestDesignApproval(ASK, new AbortController().signal);
    const { promptId } = request(posted);
    manager.resolveDesignApproval(promptId, 'changes', undefined);
    manager.resolveDesignApproval(promptId, 'changes', '  \n ');
    expect(state.pendingPrompts()).toHaveLength(1);
    expect(closed(posted)).toEqual([]);
    manager.resolveDesignApproval(promptId, 'changes', '  Make the header sticky. ');
    expect(await answer).toEqual({ choice: 'changes', feedback: 'Make the header sticky.' });
  });

  it('answers stop without a note, and ignores a second answer and one for a prompt it never raised', async () => {
    const { posted, manager } = setup();
    const answer = manager.requestDesignApproval(ASK, new AbortController().signal);
    const { promptId } = request(posted);
    manager.resolveDesignApproval('designapproval-unknown', 'approve', undefined);
    manager.resolveDesignApproval(promptId, 'stop', 'ignored');
    manager.resolveDesignApproval(promptId, 'approve', undefined);
    expect(await answer).toEqual({ choice: 'stop' });
    expect(closed(posted)).toHaveLength(1);
  });

  it('closes unanswered when its signal ends, and every view drops it', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    const answer = manager.requestDesignApproval(ASK, stop.signal);
    const { promptId } = request(posted);
    stop.abort();
    expect(await answer).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'designApprovalClosed', promptId });
    manager.resolveDesignApproval(promptId, 'approve', undefined);
    expect(closed(posted)).toHaveLength(1);
  });

  it('raises nothing on a signal that already ended', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    stop.abort();
    expect(await manager.requestDesignApproval(ASK, stop.signal)).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('waits with no webview attached, for repostPendingPrompts to show it to the next one', () => {
    const { state, manager } = setup(false);
    void manager.requestDesignApproval(ASK, new AbortController().signal);
    expect(state.pendingPrompts().map((p) => p.kind)).toEqual(['designApproval']);
  });

  it('every add and remove reaches the session-state publisher', async () => {
    const { posted, manager, changes } = setup();
    const answer = manager.requestDesignApproval(ASK, new AbortController().signal);
    expect(changes()).toBe(1);
    manager.resolveDesignApproval(request(posted).promptId, 'stop', undefined);
    await answer;
    expect(changes()).toBe(2);
  });
});

describe('PermissionHandler and the designApproval prompt', () => {
  function handlerWith() {
    const handler = new PermissionHandler(createFakePlatform());
    const posted: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((m) => posted.push(m));
    return { handler, posted };
  }

  it('asks with YOLO on, and no mode or YOLO change answers it', async () => {
    const { handler, posted } = handlerWith();
    expect(handler.setDangerouslySkipPermissions(true)).toBe(true);
    const answer = handler.requestDesignApproval(ASK, new AbortController().signal);
    const { promptId } = request(posted);
    handler.setPermissionMode('acceptEdits');
    handler.setDangerouslySkipPermissions(false);
    handler.setDangerouslySkipPermissions(true);
    handler.setPermissionMode('default');
    expect(handler.pendingPrompts().map((p) => p.kind)).toEqual(['designApproval']);
    expect(closed(posted)).toEqual([]);
    handler.resolveDesignApproval(promptId, 'approve', undefined);
    expect(await answer).toEqual({ choice: 'approve' });
  });

  it('reposts the open prompt to a webview that came back, and closes it on every view on dispose', async () => {
    const { handler, posted } = handlerWith();
    const answer = handler.requestDesignApproval(ASK, new AbortController().signal);
    const sent = request(posted);
    posted.length = 0;
    handler.repostPendingPrompts();
    expect(posted).toEqual([sent]);
    await handler.dispose();
    expect(await answer).toBeUndefined();
    expect(handler.pendingPrompts()).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'designApprovalClosed', promptId: sent.promptId });
  });
});
