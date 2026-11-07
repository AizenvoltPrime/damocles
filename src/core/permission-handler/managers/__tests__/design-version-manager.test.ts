import { describe, expect, it } from 'vitest';
import { DesignVersionManager, type DesignVersionAsk } from '../design-version-manager';
import { PermissionState } from '../../state';
import { PermissionHandler } from '../..';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';

const ASK: DesignVersionAsk = { designId: 'contacts-abcd1234', fromVersion: 1, toVersion: 2, changes: [{ kind: 'screenChanged', screen: 'S1' }] };

function setup(attached = true) {
  const state = new PermissionState();
  const posted: ExtensionToWebviewMessage[] = [];
  let changes = 0;
  state.onPendingChanged = () => changes++;
  const manager = new DesignVersionManager(state, () => (attached ? (m) => posted.push(m) : null));
  return { state, posted, manager, changes: () => changes };
}

const request = (posted: ExtensionToWebviewMessage[]) => posted.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'requestDesignVersionDecision' }> => m.type === 'requestDesignVersionDecision')!;

describe('DesignVersionManager (PD-29)', () => {
  it('raises a designVersion prompt with the chat as its owner, and resolves with the answer', async () => {
    const { state, posted, manager } = setup();
    const answer = manager.requestDesignVersionDecision(ASK, new AbortController().signal);
    const sent = request(posted);
    expect(sent).toMatchObject({ type: 'requestDesignVersionDecision', designId: ASK.designId, fromVersion: 1, toVersion: 2, changes: [{ kind: 'screenChanged', screen: 'S1' }], owner: { kind: 'main' } });
    expect(state.pendingPrompts()).toEqual([{ id: sent.promptId, kind: 'designVersion', request: sent }]);

    manager.resolveDesignVersionDecision(sent.promptId, 'replan');
    expect(await answer).toBe('replan');
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'designVersionDecisionClosed', promptId: sent.promptId });
  });

  it('ignores a second answer and one for a prompt it never raised', async () => {
    const { posted, manager } = setup();
    const answer = manager.requestDesignVersionDecision(ASK, new AbortController().signal);
    const { promptId } = request(posted);
    manager.resolveDesignVersionDecision('designversion-unknown', 'replan');
    manager.resolveDesignVersionDecision(promptId, 'finishFirst');
    manager.resolveDesignVersionDecision(promptId, 'replan');
    expect(await answer).toBe('finishFirst');
    expect(posted.filter((m) => m.type === 'designVersionDecisionClosed')).toHaveLength(1);
  });

  it('closes unanswered when its signal ends, and every view drops it', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    const answer = manager.requestDesignVersionDecision(ASK, stop.signal);
    const { promptId } = request(posted);
    stop.abort();
    expect(await answer).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'designVersionDecisionClosed', promptId });
    manager.resolveDesignVersionDecision(promptId, 'replan');
    expect(posted.filter((m) => m.type === 'designVersionDecisionClosed')).toHaveLength(1);
  });

  it('raises nothing on a signal that already ended', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    stop.abort();
    expect(await manager.requestDesignVersionDecision(ASK, stop.signal)).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('waits with no webview attached, for repostPendingPrompts to show it to the next one', () => {
    const { state, manager } = setup(false);
    void manager.requestDesignVersionDecision(ASK, new AbortController().signal);
    expect(state.pendingPrompts().map((p) => p.kind)).toEqual(['designVersion']);
  });

  it('every add and remove reaches the session-state publisher', async () => {
    const { posted, manager, changes } = setup();
    const answer = manager.requestDesignVersionDecision(ASK, new AbortController().signal);
    expect(changes()).toBe(1);
    manager.resolveDesignVersionDecision(request(posted).promptId, 'finishFirst');
    await answer;
    expect(changes()).toBe(2);
  });
});

describe('PermissionHandler and the designVersion prompt', () => {
  it('reposts the open prompt to a webview that came back, and settles it unanswered on dispose', async () => {
    const handler = new PermissionHandler(createFakePlatform());
    const posted: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((m) => posted.push(m));
    const answer = handler.requestDesignVersionDecision(ASK, new AbortController().signal);
    const sent = request(posted);
    posted.length = 0;
    handler.repostPendingPrompts();
    expect(posted).toEqual([sent]);
    await handler.dispose();
    expect(await answer).toBeUndefined();
    expect(handler.pendingPrompts()).toEqual([]);
  });
});
